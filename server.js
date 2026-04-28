/**
 * ============================================================
 * FacialPass AI — Express Server (Backend API)
 * ============================================================
 * 
 * This is the main backend server that provides 4 API endpoints:
 * 
 *  POST /register           → Register a student (face + info → embeddings → Firestore)
 *  POST /extract-embeddings → Extract embeddings from an image (for scan comparison)
 *  GET  /get-students       → Fetch all registered students + embeddings
 *  POST /log-entry          → Log an access event (granted/denied)
 * 
 * ── Firestore Collections Schema ──
 * 
 * students/{studentId}
 *   ├── name: string            (e.g., "John Doe")
 *   ├── studentId: string       (e.g., "STU-2024-001")
 *   ├── embeddings: number[]    (128 floats — the face fingerprint)
 *   └── registeredAt: timestamp (when they registered)
 * 
 * logs/{auto-generated-id}
 *   ├── studentId: string
 *   ├── name: string
 *   ├── status: "granted" | "denied"
 *   └── timestamp: timestamp
 * 
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { db, admin } = require('./firebaseConfig');
const { loadModels, extractEmbeddings } = require('./utils/faceEngine');
const { registerAdminRoutes } = require('./routes/adminAuth');

// ── Initialize Express app ──
const app = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ──
app.use(cors());                          // Allow cross-origin requests from mobile app
app.use(express.json({ limit: '50mb' })); // Parse JSON bodies (large for base64 images)

// ── Configure Multer for image uploads ──
// Stores uploaded images in memory (as Buffer) — we never save them to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
  fileFilter: (req, file, cb) => {
    // Only accept image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// ── Register Admin Auth Routes ──
registerAdminRoutes(app, db);

// ═══════════════════════════════════════════════════════════════
//  ENDPOINT 1: POST /register
//  Register a new student with their face
// ═══════════════════════════════════════════════════════════════
app.post('/register', upload.single('image'), async (req, res) => {
  try {
    const { studentId, name } = req.body;

    // ── Validate required fields ──
    if (!studentId || !name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: studentId and name are required'
      });
    }

    if (!req.file && !req.body.imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided. Send an image file or base64 string.'
      });
    }

    // ── Get image buffer (from file upload OR base64 string) ──
    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else {
      // Handle base64 encoded image from mobile app
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    }

    console.log(`\n📝 Registering student: ${name} (${studentId})`);

    // ── Extract face embeddings using AI engine ──
    const result = await extractEmbeddings(imageBuffer);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    // ── Save to Firestore ──
    // We store ONLY the 128-float embeddings, NEVER the raw image
    // Sanitize studentId: Firestore doc IDs cannot contain '/'
    const docId = studentId.replace(/\//g, '-');

    if (db) {
      await db.collection('students').doc(docId).set({
        studentId: studentId,
        name: name,
        embeddings: result.embeddings,  // 128 floats
        registeredAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`  💾 Saved to Firestore: students/${docId}`);
    } else {
      console.warn('  ⚠️  Firestore not connected — data not saved');
    }

    // ── Return success ──
    res.json({
      success: true,
      message: `Student "${name}" registered successfully`,
      studentId: studentId,
      embeddingLength: result.embeddings.length,  // Should always be 128
      confidence: result.confidence
    });

  } catch (error) {
    console.error('❌ Registration error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error during registration: ' + error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ENDPOINT 2: POST /extract-embeddings
//  Extract embeddings from an image (used during face scanning)
// ═══════════════════════════════════════════════════════════════
app.post('/extract-embeddings', upload.single('image'), async (req, res) => {
  try {
    if (!req.file && !req.body.imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided. Send an image file or base64 string.'
      });
    }

    // ── Get image buffer ──
    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else {
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    }

    console.log('\n🔍 Extracting embeddings for scan...');

    // ── Extract face embeddings ──
    const result = await extractEmbeddings(imageBuffer);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      embeddings: result.embeddings,
      confidence: result.confidence
    });

  } catch (error) {
    console.error('❌ Embedding extraction error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error during embedding extraction: ' + error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ENDPOINT 3: GET /get-students
//  Fetch all registered students with their embeddings
// ═══════════════════════════════════════════════════════════════
app.get('/get-students', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.'
      });
    }

    console.log('\n📋 Fetching all registered students...');

    const snapshot = await db.collection('students').get();
    const students = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      students.push({
        studentId: data.studentId,
        name: data.name,
        embeddings: data.embeddings,  // 128-float array
        registeredAt: data.registeredAt
      });
    });

    console.log(`  📊 Found ${students.length} registered student(s)`);

    res.json({
      success: true,
      count: students.length,
      students: students
    });

  } catch (error) {
    console.error('❌ Fetch students error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error fetching students: ' + error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ENDPOINT 4: POST /log-entry
//  Log an access event (granted or denied)
// ═══════════════════════════════════════════════════════════════
app.post('/log-entry', async (req, res) => {
  try {
    const { studentId, name, status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: status ("granted" or "denied")'
      });
    }

    if (db) {
      await db.collection('logs').add({
        studentId: studentId || 'unknown',
        name: name || 'Unknown',
        status: status,  // "granted" or "denied"
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`  📋 Access log: ${name || 'Unknown'} — ${status}`);
    }

    res.json({
      success: true,
      message: 'Access log recorded'
    });

  } catch (error) {
    console.error('❌ Log entry error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error logging entry: ' + error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ENDPOINT 5: GET /get-logs
//  Fetch access logs from Firestore (for History tab)
// ═══════════════════════════════════════════════════════════════
app.get('/get-logs', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.'
      });
    }

    const limit = parseInt(req.query.limit) || 50;

    console.log(`\n📋 Fetching access logs (limit: ${limit})...`);

    const snapshot = await db.collection('logs')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const logs = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        studentId: data.studentId,
        name: data.name,
        status: data.status,
        timestamp: data.timestamp
      });
    });

    console.log(`  📊 Found ${logs.length} log(s)`);

    res.json({
      success: true,
      count: logs.length,
      logs: logs
    });

  } catch (error) {
    console.error('❌ Fetch logs error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error fetching logs: ' + error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ENDPOINT 6: DELETE /delete-student/:id
//  Delete a student from Firestore
// ═══════════════════════════════════════════════════════════════
app.delete('/delete-student/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.'
      });
    }

    const studentId = req.params.id;
    const docId = studentId.replace(/\//g, '-');

    console.log(`\n🗑️  Deleting student: ${studentId}`);

    const docRef = db.collection('students').doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        error: `Student with ID "${studentId}" not found.`
      });
    }

    await docRef.delete();
    console.log(`  ✅ Student deleted: ${docId}`);

    res.json({
      success: true,
      message: `Student "${studentId}" has been deleted.`
    });

  } catch (error) {
    console.error('❌ Delete student error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error deleting student: ' + error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  HEALTH CHECK: GET /
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    name: 'FacialPass AI — Backend API',
    version: '2.0.0',
    status: 'running',
    firebase: db ? 'connected' : 'disconnected',
    endpoints: {
      register: 'POST /register',
      extractEmbeddings: 'POST /extract-embeddings',
      getStudents: 'GET /get-students',
      logEntry: 'POST /log-entry',
      getLogs: 'GET /get-logs',
      deleteStudent: 'DELETE /delete-student/:id',
      clearLogs: 'POST /clear-logs',
      adminRegister: 'POST /admin/register',
      adminLogin: 'POST /admin/login',
      adminVerifyOtp: 'POST /admin/verify-otp',
      adminResendOtp: 'POST /admin/resend-otp',
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  SERVER STARTUP
//  Loads AI models FIRST, then starts listening for requests
// ═══════════════════════════════════════════════════════════════
async function startServer() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       FacialPass AI — Backend Server         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    // Load AI models before accepting any requests
    await loadModels();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📡 Endpoints ready:`);
      console.log(`   POST   /register              — Register a student`);
      console.log(`   POST   /extract-embeddings     — Extract face embeddings`);
      console.log(`   GET    /get-students            — Fetch all students`);
      console.log(`   POST   /log-entry               — Log access event`);
      console.log(`   GET    /get-logs                — Fetch access logs`);
      console.log(`   DELETE /delete-student/:id       — Delete a student`);
      console.log(`   POST   /admin/register          — Admin registration + OTP`);
      console.log(`   POST   /admin/login             — Admin login`);
      console.log(`   POST   /admin/verify-otp        — Verify email OTP`);
      console.log(`   POST   /admin/resend-otp        — Resend OTP (60s cooldown)`);
      console.log(`   POST   /clear-logs              — Batch delete all logs\n`);
    });
  } catch (error) {
    console.error('💀 Server failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
