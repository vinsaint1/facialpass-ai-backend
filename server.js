/**
 * Express Server (Backend API)
 * Provides REST API endpoints for authentication, registration,
 * verification, analytics, reports, and attendance logging.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { db, admin } = require('./firebaseConfig');
const { loadModels, extractEmbeddings } = require('./utils/faceEngine');
const { registerAdminRoutes } = require('./routes/adminAuth');
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');
let expo = new Expo();

// Domain Models
const Employee = require('./domain/Employee');
const AttendanceRecord = require('./domain/AttendanceRecord');
const Schedule = require('./domain/Schedule');
const LeaveRequest = require('./domain/LeaveRequest');
const PayrollCalculator = require('./domain/PayrollCalculator');
const PredictiveAnalyticsEngine = require('./domain/PredictiveAnalyticsEngine');

const getColName = (baseName, adminEmailOrReq) => {
  let adminEmail = '';
  if (adminEmailOrReq) {
    if (typeof adminEmailOrReq === 'string') {
      adminEmail = adminEmailOrReq;
    } else if (adminEmailOrReq.headers) {
      adminEmail = adminEmailOrReq.headers['x-admin-email'] || '';
    }
  }
  if (!adminEmail) return baseName;
  const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${baseName}_${cleanEmail}`;
};

const getLocalDateString = (d = new Date()) => {
  const offset = d.getTimezoneOffset();
  const localDate = new Date(d.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split('T')[0];
};

const getClientLocalDateString = (d = new Date(), clientOffset = 0) => {
  const localDate = new Date(d.getTime() - (clientOffset * 60 * 1000));
  return localDate.toISOString().split('T')[0];
};


// Initialize Express app
const app = express();
const PORT = process.env.PORT || 5005;

// Middleware
app.use(cors());                          // Allow cross-origin requests from mobile app
app.use(express.json({ limit: '50mb' })); // Parse JSON bodies (large for base64 images)
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// In-Memory Employee Caches partitioned by adminEmail
const employeeCaches = new Map(); // adminEmail -> { employees, time }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getEmployeesFromCache(adminEmail = '') {
  const cacheKey = adminEmail.toLowerCase();
  const entry = employeeCaches.get(cacheKey);
  if (entry && (Date.now() - entry.time < CACHE_TTL)) {
    return entry.employees;
  }
  
  if (!db) return [];
  
  const colName = getColName('employees', adminEmail);
  let query = db.collection(colName);
  
  const snapshot = await query.get();
  const employees = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    employees.push({
      employeeId: data.employeeId,
      name: data.name,
      embeddings: data.embeddings,
    });
  });
  employeeCaches.set(cacheKey, { employees, time: Date.now() });
  console.log(`[DB] Employee cache refreshed for "${cacheKey || 'global'}": ${employees.length} employee(s)`);
  return employees;
}

function invalidateEmployeeCache(adminEmail = '') {
  const cacheKey = adminEmail.toLowerCase();
  employeeCaches.delete(cacheKey);
  employeeCaches.delete(''); // Invalidate fallback cache as well
}

// Register Admin Auth Routes
registerAdminRoutes(app, db);

// Endpoint: POST /register
// Register a new employee with their face
app.post('/register', upload.single('image'), async (req, res) => {
  try {
    const { employeeId, name } = req.body;

    // Validate required fields
    if (!employeeId || !name) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: employeeId and name are required'
      });
    }

    if (!req.file && !req.body.imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided. Send an image file or base64 string.'
      });
    }

    // Get image buffer (from file upload OR base64 string)
    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else {
      // Handle base64 encoded image from mobile app
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    }

    console.log(`[API] Registering employee: ${name} (${employeeId})`);

    // Extract face embeddings using AI engine
    const result = await extractEmbeddings(imageBuffer);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    // Save to Firestore using Employee Class
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const docId = employeeId.replace(/\//g, '-');
    const newEmployee = new Employee(
      docId, name, `${docId}@example.com`, 'employee', 15.00, result.embeddings, new Date(), adminEmail
    );
    await newEmployee.save();
    invalidateEmployeeCache(adminEmail); // New employee must be in next scan
    console.log(`[DB] Saved to Firestore: employees/${docId} (Admin: ${adminEmail || 'none'})`);

    // Return success
    res.json({
      success: true,
      message: `Employee "${name}" registered successfully`,
      employeeId: employeeId,
      embeddingLength: result.embeddings.length,  // Should always be 128
      confidence: result.confidence
    });

  } catch (error) {
    console.error('[ERROR] Registration error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error during registration: ' + error.message
    });
  }
});

// Endpoint: POST /extract-embeddings
// Extract embeddings from an image (used during face scanning)
app.post('/extract-embeddings', upload.single('image'), async (req, res) => {
  try {
    if (!req.file && !req.body.imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided. Send an image file or base64 string.'
      });
    }

    // Get image buffer
    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else {
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    }

    console.log('[API] Extracting embeddings for scan...');

    // Extract face embeddings
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
    console.error('[ERROR] Embedding extraction error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error during embedding extraction: ' + error.message
    });
  }
});

// Endpoint: POST /verify-face
// Single-shot face verification (extract embeddings + database matching)
app.post('/verify-face', upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  req.setTimeout(300000);
  
  try {
    if (!req.file && !req.body.imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided. Send an image file via FormData or a base64 string.'
      });
    }

    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
      console.log(`[API] [verify-face] Received image file: ${(req.file.size / 1024).toFixed(1)} KB`);
    } else {
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
      console.log(`[API] [verify-face] Received base64 image: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
    }

    console.log('[AI] Extracting embeddings...');
    const embeddingStart = Date.now();
    const embeddingResult = await extractEmbeddings(imageBuffer);
    const embeddingTime = Date.now() - embeddingStart;

    if (!embeddingResult.success) {
      return res.status(400).json({
        success: false,
        error: embeddingResult.error || 'No face detected in the image.',
        processingTimeMs: Date.now() - startTime
      });
    }

    console.log(`[AI] Embeddings extracted in ${embeddingTime}ms (confidence: ${(embeddingResult.confidence * 100).toFixed(1)}%)`);

    console.log('[DB] Fetching employee database...');
    const fetchStart = Date.now();

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.',
        processingTimeMs: Date.now() - startTime
      });
    }

    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const employees = await getEmployeesFromCache(adminEmail);
    const fetchTime = Date.now() - fetchStart;

    console.log(`[DB] Retrieved ${employees.length} employee(s) in ${fetchTime}ms (cached for ${adminEmail || 'global'})`);

    if (employees.length === 0) {
      return res.json({
        success: true,
        matched: false,
        employee: null,
        distance: Infinity,
        confidence: embeddingResult.confidence,
        threshold: parseFloat(req.query.threshold) || 0.6,
        error: 'No employees registered in the database.',
        processingTimeMs: Date.now() - startTime
      });
    }

    console.log('[AI] Matching face against database...');
    const matchStart = Date.now();
    const threshold = parseFloat(req.query.threshold) || 0.6;
    const liveEmbedding = embeddingResult.embeddings;

    let bestMatch = null;
    let bestDistance = Infinity;

    for (const emp of employees) {
      if (!emp.embeddings || !Array.isArray(emp.embeddings)) continue;
      if (emp.embeddings.length !== liveEmbedding.length) continue;

      let sumOfSquares = 0;
      for (let i = 0; i < liveEmbedding.length; i++) {
        const diff = liveEmbedding[i] - emp.embeddings[i];
        sumOfSquares += diff * diff;
      }
      const distance = Math.sqrt(sumOfSquares);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = emp;
      }
    }

    const isMatch = bestDistance < threshold;
    const matchTime = Date.now() - matchStart;
    const totalTime = Date.now() - startTime;

    console.log(`[AI] Match complete in ${matchTime}ms — ${isMatch ? 'MATCHED' : 'NO MATCH'} (distance: ${bestDistance.toFixed(4)}, threshold: ${threshold})`);

    let isClockedIn = false;
    if (isMatch && db) {
      const clientOffset = parseInt(req.headers['x-timezone-offset'] || '0', 10);
      const todayStr = getClientLocalDateString(new Date(), clientOffset);
      const activeSession = await db.collection(getColName('attendance_logs', adminEmail))
        .where('employeeId', '==', bestMatch.employeeId)
        .where('date', '==', todayStr)
        .get();
      activeSession.forEach(doc => {
        const data = doc.data();
        if (data.clockInTime && !data.clockOutTime) {
          isClockedIn = true;
        }
      });
    }

    console.log(`[SYSTEM] Total verify-face pipeline: ${totalTime}ms (isClockedIn: ${isClockedIn})`);

    res.json({
      success: true,
      matched: isMatch,
      employee: isMatch ? { employeeId: bestMatch.employeeId, name: bestMatch.name } : null,
      isClockedIn: isClockedIn,
      distance: bestDistance,
      confidence: embeddingResult.confidence,
      threshold: threshold,
      processingTimeMs: totalTime,
    });

  } catch (error) {
    console.error('[ERROR] [verify-face] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error during face verification: ' + error.message,
      processingTimeMs: Date.now() - startTime
    });
  }
});

// Endpoint: GET /get-employees
// Fetch all registered employees
app.get('/get-employees', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.'
      });
    }

    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    if (req.query.bypassCache === 'true') {
      invalidateEmployeeCache(adminEmail);
    }
    const employees = await getEmployeesFromCache(adminEmail);

    res.json({
      success: true,
      count: employees.length,
      employees: employees
    });

  } catch (error) {
    console.error('[ERROR] Fetch employees error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error fetching employees: ' + error.message
    });
  }
});

// Endpoint: POST /api/attendance/clock-in
app.post('/api/attendance/clock-in', async (req, res) => {
  try {
    const { employeeId, faceDistanceScore, workHoursStart, workHoursEnd, captureTime, workHoursEnabled } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId required' });
    
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const clientOffset = parseInt(req.headers['x-timezone-offset'] || '0', 10);
    const record = await AttendanceRecord.clockIn(
      employeeId, faceDistanceScore, workHoursStart, workHoursEnd, captureTime, adminEmail, !!workHoursEnabled, clientOffset
    );
    res.json({ success: true, message: 'Clocked in successfully', record });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/attendance/clock-out
app.post('/api/attendance/clock-out', async (req, res) => {
  try {
    const { employeeId, workHoursEnd, workHoursEnabled, workHoursStart } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId required' });
    
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const clientOffset = parseInt(req.headers['x-timezone-offset'] || '0', 10);
    const record = await AttendanceRecord.clockOut(
      employeeId, workHoursEnd, adminEmail, !!workHoursEnabled, workHoursStart, clientOffset
    );
    res.json({ success: true, message: 'Clocked out successfully', record });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /log-entry
app.post('/log-entry', async (req, res) => {
  try {
    const { employeeId, name, status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: status ("granted" or "denied")'
      });
    }

    if (db) {
      const colName = getColName('logs', req);
      await db.collection(colName).add({
        employeeId: employeeId || 'unknown',
        name: name || 'Unknown',
        status: status,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[API] Access log [${colName}]: ${name || 'Unknown'} - ${status}`);
    }

    res.json({
      success: true,
      message: 'Access log recorded'
    });

  } catch (error) {
    console.error('[ERROR] Log entry error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error logging entry: ' + error.message
    });
  }
});

// Endpoint: GET /get-logs
// Fetch access logs from Firestore (for History tab)
// Merges both general logs (denied) and attendance_logs (granted/clocked in)
app.get('/get-logs', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.'
      });
    }

    const limit = parseInt(req.query.limit) || 50;
    const logsCol = getColName('logs', req);
    const attCol = getColName('attendance_logs', req);
    console.log(`[API] Fetching unified access logs (limit: ${limit}) from ${logsCol} and ${attCol}...`);

    // Fetch legacy/denied logs
    const logsSnapshot = await db.collection(logsCol)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    // Fetch attendance logs (clock ins)
    const attendanceSnapshot = await db.collection(attCol)
      .orderBy('clockInTime', 'desc')
      .limit(limit)
      .get();

    let logs = [];

    // Process legacy logs
    logsSnapshot.forEach((doc) => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        employeeId: data.employeeId || '',
        name: data.name,
        status: data.status,
        timestamp: data.timestamp,
        type: data.type || 'legacy',
        message: data.message || ''
      });
    });

    // Process attendance logs
    attendanceSnapshot.forEach((doc) => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        employeeId: data.employeeId,
        name: `Employee ${data.employeeId}`, 
        status: 'granted', 
        attendanceStatus: data.status,
        timestamp: data.clockInTime,
        clockOutTime: data.clockOutTime,
        totalHours: data.totalHours,
        type: 'attendance'
      });
    });

    // Sort combined logs by timestamp descending
    logs.sort((a, b) => {
      const tA = a.timestamp?.toDate ? a.timestamp.toDate().getTime() : new Date(a.timestamp || 0).getTime();
      const tB = b.timestamp?.toDate ? b.timestamp.toDate().getTime() : new Date(b.timestamp || 0).getTime();
      return tB - tA;
    });

    // Trim to limit
    logs = logs.slice(0, limit);

    console.log(`[API] Found ${logs.length} unified log(s)`);

    res.json({
      success: true,
      count: logs.length,
      logs: logs
    });

  } catch (error) {
    console.error('[ERROR] Fetch logs error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error fetching logs: ' + error.message
    });
  }
});

// Endpoint: GET /api/attendance/logs/:employeeId
// Fetch personal attendance history for a specific employee
app.get('/api/attendance/logs/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId required' });

    console.log(`[API] Fetching personal attendance logs for ${employeeId}...`);

    const colName = getColName('attendance_logs', req);
    const snapshot = await db.collection(colName)
      .where('employeeId', '==', employeeId)
      .orderBy('date', 'desc')
      .limit(30)
      .get();

    const logs = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      logs.push({
        id: doc.id,
        date: data.date,
        clockInTime: data.clockInTime,
        clockOutTime: data.clockOutTime,
        status: data.status,
        totalHours: data.totalHours,
        latenessMinutes: data.latenessMinutes
      });
    });

    res.json({ success: true, logs });
  } catch (error) {
    console.error('[ERROR] Fetch personal logs error:', error.message);
    res.status(500).json({ success: false, error: 'Server error: ' + error.message });
  }
});


// Core daily report generation logic
async function generateDailyReportCore(adminEmail, targetDate, req) {
  const empCol = getColName('employees', adminEmail);
  const attCol = getColName('attendance_logs', adminEmail);
  const leavesCol = getColName('leave_requests', adminEmail);
  const repCol = getColName('daily_reports', adminEmail);
  const logsCol = getColName('logs', adminEmail);

  console.log(`[CRON/API] Generating daily report for ${targetDate} (Admin: ${adminEmail})...`);

  const employeesSnap = await db.collection(empCol).get();
  const employees = [];
  employeesSnap.forEach(doc => employees.push(doc.data()));

  const attendanceSnap = await db.collection(attCol)
    .where('date', '==', targetDate)
    .get();
  
  const attendanceByEmp = {};
  attendanceSnap.forEach(doc => {
    const data = doc.data();
    if (data.status === 'absent' && !data.clockInTime) return;
    if (!attendanceByEmp[data.employeeId]) attendanceByEmp[data.employeeId] = [];
    attendanceByEmp[data.employeeId].push(data);
  });

  const leavesSnap = await db.collection(leavesCol)
    .where('status', '==', 'approved')
    .get();
  
  const leavesByEmp = {};
  leavesSnap.forEach(doc => {
    const data = doc.data();
    if (data.startDate <= targetDate && data.endDate >= targetDate) {
      leavesByEmp[data.employeeId] = data;
    }
  });

  const shouldSave = !attendanceSnap.empty || targetDate < getLocalDateString(new Date());

  const report = {
    date: targetDate,
    totalEmployees: employees.length,
    present: 0,
    absent: 0,
    leave: 0,
    late: 0,
    missingClockOut: 0,
    totalSessions: 0,
    details: []
  };

  const getTimeMs = (ts) => {
    if (!ts) return 0;
    if (ts.toDate) return ts.toDate().getTime();
    if (ts._seconds) return ts._seconds * 1000;
    return new Date(ts).getTime() || 0;
  };

  let maxSessionsForDay = 1;
  Object.values(attendanceByEmp).forEach(sessions => {
    if (sessions && sessions.length > maxSessionsForDay) {
      maxSessionsForDay = sessions.length;
    }
  });
  report.totalSessions = maxSessionsForDay;

  employees.forEach(emp => {
    const sessions = attendanceByEmp[emp.employeeId];
    const activeLeave = leavesByEmp[emp.employeeId];

    if (!sessions || sessions.length === 0) {
      if (activeLeave) {
        report.leave++;
        const leaveType = activeLeave.type || 'leave';
        for (let i = 1; i <= maxSessionsForDay; i++) {
          report.details.push({ employeeId: emp.employeeId, name: emp.name, status: leaveType, session: i });
        }
        if (shouldSave) {
          db.collection(attCol).doc(`LEAVE-${targetDate}-${emp.employeeId}`).set({
            logId: `LEAVE-${targetDate}-${emp.employeeId}`, employeeId: emp.employeeId, date: targetDate,
            status: leaveType, totalHours: 0, latenessMinutes: 0, type: 'attendance', adminEmail: adminEmail
          }).catch(console.error);
        }
      } else {
        report.absent++;
        for (let i = 1; i <= maxSessionsForDay; i++) {
          report.details.push({ employeeId: emp.employeeId, name: emp.name, status: 'absent', session: i });
        }
        if (shouldSave) {
          db.collection(attCol).doc(`ABSENT-${targetDate}-${emp.employeeId}`).set({
            logId: `ABSENT-${targetDate}-${emp.employeeId}`, employeeId: emp.employeeId, date: targetDate,
            status: 'absent', totalHours: 0, latenessMinutes: 0, type: 'attendance', adminEmail: adminEmail
          }).catch(console.error);
        }
      }
    } else {
      report.present++;
      sessions.sort((a, b) => getTimeMs(a.clockInTime) - getTimeMs(b.clockInTime));
      sessions.forEach((log, idx) => {
        if (log.status === 'late') report.late++;
        if (!log.clockOutTime && log.status !== 'absent') report.missingClockOut++;
        const clockInISO = log.clockInTime ? (log.clockInTime.toDate ? log.clockInTime.toDate().toISOString() : new Date(log.clockInTime).toISOString()) : null;
        const clockOutISO = log.clockOutTime ? (log.clockOutTime.toDate ? log.clockOutTime.toDate().toISOString() : new Date(log.clockOutTime).toISOString()) : null;
        report.details.push({ 
          employeeId: emp.employeeId, name: emp.name, status: log.status,
          clockInTime: clockInISO, clockOutTime: clockOutISO, totalHours: log.totalHours || 0,
          session: idx + 1, totalSessionsForEmployee: sessions.length, logId: log.logId
        });
      });
      for (let i = sessions.length + 1; i <= maxSessionsForDay; i++) {
        report.details.push({ employeeId: emp.employeeId, name: emp.name, status: 'absent', session: i, totalSessionsForEmployee: sessions.length });
      }
    }
  });

  if (shouldSave) {
    await db.collection(repCol).doc(targetDate).set(report);
    await db.collection(logsCol).add({
      type: 'report', name: 'Daily Report',
      message: `Daily attendance report for ${targetDate}: ${report.present} present, ${report.absent} absent, ${report.late} late, ${report.totalSessions} total sessions.`,
      status: 'granted', timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  return report;
}



// Endpoint: POST /api/admin/settings
app.post('/api/admin/settings', async (req, res) => {
  try {
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const { workHoursStart, workHoursEnd, timezoneOffset } = req.body;
    if (!adminEmail) return res.status(400).json({ success: false, error: 'Admin email required' });
    
    await db.collection('admins').doc(adminEmail).set({
      workHoursStart,
      workHoursEnd,
      timezoneOffset,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: POST /api/admin/push-token
app.post('/api/admin/push-token', async (req, res) => {
  try {
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const { pushToken } = req.body;
    if (!adminEmail || !pushToken) return res.status(400).json({ success: false, error: 'Missing data' });
    
    await db.collection('admins').doc(adminEmail).set({
      pushToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint: POST /api/reports/generate-daily
app.post('/api/reports/generate-daily', async (req, res) => {
  try {
    const { date } = req.body;
    const targetDate = date || getLocalDateString(new Date());
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    
    const report = await generateDailyReportCore(adminEmail, targetDate, req);
    res.json({ success: true, message: 'Report generated successfully', report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: GET /api/reports/monthly
// Aggregates daily reports for a given month into a comprehensive monthly summary.
app.get('/api/reports/monthly', async (req, res) => {
  try {
    const { monthPrefix } = req.query; // e.g. "2026-07"
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    console.log(`[API] GET /api/reports/monthly: monthPrefix=${monthPrefix}, adminEmail=${adminEmail}`);
    const empCol = getColName('employees', req);
    const attCol = getColName('attendance_logs', req);

    // 1. Get all employees
    const employeesSnap = await db.collection(empCol).get();
    const employees = [];
    employeesSnap.forEach(doc => employees.push(doc.data()));

    if (employees.length === 0) {
      return res.json({ success: true, summary: { totalEmployees: 0 } });
    }

    // 2. Get all attendance logs for the month
    const startDate = `${monthPrefix}-01`;
    const [yearStr, monthStr] = monthPrefix.split('-');
    const lastDay = new Date(parseInt(yearStr), parseInt(monthStr), 0).getDate();
    const endDate = `${monthPrefix}-${lastDay.toString().padStart(2, '0')}`;

    const attendanceSnap = await db.collection(attCol)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    // Organize logs by employee and by date
    const logsByEmpDate = {}; // { empId: { date: [logs] } }
    const logsByDate = {};    // { date: [logs] }

    attendanceSnap.forEach(doc => {
      const data = doc.data();
      if (!data.employeeId || !data.date) return;

      if (!logsByEmpDate[data.employeeId]) logsByEmpDate[data.employeeId] = {};
      if (!logsByEmpDate[data.employeeId][data.date]) logsByEmpDate[data.employeeId][data.date] = [];
      logsByEmpDate[data.employeeId][data.date].push(data);

      if (!logsByDate[data.date]) logsByDate[data.date] = [];
      logsByDate[data.date].push(data);
    });

    // 3. Calculate working days up to today
    const today = getLocalDateString(new Date());
    const effectiveEndDate = endDate < today ? endDate : today;
    let workingDays = 0;
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${monthPrefix}-${d.toString().padStart(2, '0')}`;
      if (dateStr > effectiveEndDate) break;
      const dayOfWeek = new Date(parseInt(yearStr), parseInt(monthStr) - 1, d).getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) workingDays++; // Exclude weekends
    }
    if (workingDays === 0) workingDays = 1; // Prevent division by zero

    // 4. Build per-employee report
    let totalPresentDays = 0;
    let totalLateDays = 0;
    let totalAbsentDays = 0;
    let totalLeaveDays = 0;
    let totalEarlyDepartures = 0;

    const employeeReport = employees.map(emp => {
      const empLogs = logsByEmpDate[emp.employeeId] || {};
      let presentDays = 0;
      let absentDays = 0;
      let lateDays = 0;
      let leaveDays = 0;
      let earlyDepartures = 0;

      // Check each working day
      for (let d = 1; d <= lastDay; d++) {
        const dateStr = `${monthPrefix}-${d.toString().padStart(2, '0')}`;
        if (dateStr > effectiveEndDate) break;
        const dayOfWeek = new Date(parseInt(yearStr), parseInt(monthStr) - 1, d).getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue; // Skip weekends

        const dayLogs = empLogs[dateStr] || [];
        if (dayLogs.length === 0) {
          absentDays++;
        } else {
          const hasLeave = dayLogs.some(l => l.status === 'sick_leave' || l.status === 'annual_leave' || l.status === 'leave' || l.status === 'remote_work');
          const hasAbsent = dayLogs.every(l => l.status === 'absent' && !l.clockInTime);
          const hasLate = dayLogs.some(l => l.status === 'late');

          if (hasAbsent) {
            absentDays++;
          } else if (hasLeave) {
            leaveDays++;
          } else {
            presentDays++;
            if (hasLate) lateDays++;
          }
        }
      }

      const attendanceRate = (presentDays / workingDays) * 100;

      totalPresentDays += presentDays;
      totalLateDays += lateDays;
      totalAbsentDays += absentDays;
      totalLeaveDays += leaveDays;
      totalEarlyDepartures += earlyDepartures;

      return {
        employeeId: emp.employeeId,
        name: emp.name,
        presentDays,
        absentDays,
        lateDays,
        leaveDays,
        earlyDepartures,
        attendanceRate: Math.min(attendanceRate, 100)
      };
    });

    // 5. Summary
    const overallAttendanceRate = employees.length > 0 
      ? (totalPresentDays / (workingDays * employees.length)) * 100 
      : 0;

    const summary = {
      totalEmployees: employees.length,
      presentDays: totalPresentDays,
      lateArrivals: totalLateDays,
      earlyDepartures: totalEarlyDepartures,
      attendanceRate: Math.min(overallAttendanceRate, 100)
    };

    // 6. Top Performers (attendance rate >= 90%)
    const topPerformers = employeeReport
      .filter(e => e.attendanceRate >= 90)
      .sort((a, b) => b.attendanceRate - a.attendanceRate)
      .slice(0, 5);

    // 7. Requiring Attention (attendance rate < 80% or late > 3)
    const requiringAttention = employeeReport
      .filter(e => e.attendanceRate < 80 || e.lateDays > 3)
      .map(e => ({
        name: e.name,
        reason: e.attendanceRate < 80 
          ? `Low attendance: ${e.attendanceRate.toFixed(1)}%` 
          : `Frequent late arrivals: ${e.lateDays} days`
      }));

    // 8. Daily Trend (attendance % per day)
    const dailyTrendLabels = [];
    const dailyTrendData = [];
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${monthPrefix}-${d.toString().padStart(2, '0')}`;
      if (dateStr > effectiveEndDate) break;
      const dayOfWeek = new Date(parseInt(yearStr), parseInt(monthStr) - 1, d).getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      dailyTrendLabels.push(dateStr);
      const dayLogs = logsByDate[dateStr] || [];
      const presentEmps = new Set();
      dayLogs.forEach(l => {
        if (l.clockInTime && l.status !== 'absent') presentEmps.add(l.employeeId);
      });
      dailyTrendData.push(employees.length > 0 ? (presentEmps.size / employees.length) * 100 : 0);
    }

    // 9. Status Distribution
    let sickLeaveCount = 0;
    let annualLeaveCount = 0;
    let remoteWorkCount = 0;
    attendanceSnap.forEach(doc => {
      const s = doc.data().status;
      if (s === 'sick_leave') sickLeaveCount++;
      else if (s === 'annual_leave') annualLeaveCount++;
      else if (s === 'remote_work') remoteWorkCount++;
    });

    const statusDistribution = {
      present: totalPresentDays,
      absent: totalAbsentDays,
      sickLeave: sickLeaveCount,
      annualLeave: annualLeaveCount,
      remoteWork: remoteWorkCount
    };

    // 10. Weekly Late Arrivals
    const weeklyLates = { labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'], data: [0, 0, 0, 0, 0] };
    attendanceSnap.forEach(doc => {
      const data = doc.data();
      if (data.status === 'late' && data.date) {
        const day = parseInt(data.date.split('-')[2]);
        const weekIdx = Math.min(Math.floor((day - 1) / 7), 4);
        weeklyLates.data[weekIdx]++;
      }
    });

    res.json({
      success: true,
      summary,
      employeeReport,
      topPerformers,
      requiringAttention,
      dailyTrend: { labels: dailyTrendLabels, data: dailyTrendData },
      statusDistribution,
      weeklyLates
    });

  } catch (error) {
    console.error('[ERROR] Monthly report error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/schedules
app.post('/api/schedules', async (req, res) => {
  try {
    const { employeeId, dayOfWeek, startTime, endTime, isOffDay } = req.body;
    const scheduleId = `SCH-${employeeId}-${dayOfWeek}`;
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const schedule = new Schedule(scheduleId, employeeId, dayOfWeek, startTime, endTime, isOffDay, adminEmail);
    await schedule.save();
    res.json({ success: true, message: 'Schedule saved', schedule });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: GET /api/payroll/:employeeId/:year/:month
app.get('/api/payroll/:employeeId/:year/:month', async (req, res) => {
  try {
    const { employeeId, year, month } = req.params;
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const report = await PayrollCalculator.generateMonthlyReport(employeeId, parseInt(year), parseInt(month), adminEmail);
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/leaves
app.post('/api/leaves', async (req, res) => {
  try {
    const { employeeId, startDate, endDate, type, reason } = req.body;
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    
    if (!employeeId || !startDate || !endDate || !type) {
      return res.status(400).json({ success: false, error: 'employeeId, startDate, endDate, and type are required' });
    }

    // Verify employee exists in Firestore
    const empCol = getColName('employees', req);
    const empDoc = await db.collection(empCol).doc(employeeId.replace(/\//g, '-')).get();
    if (!empDoc.exists) {
      return res.status(404).json({ success: false, error: 'Employee not found. Please register your face first.' });
    }

    const requestId = `LR-${Date.now()}`;
    const leave = new LeaveRequest(requestId, employeeId, startDate, endDate, type, 'pending', reason, adminEmail);
    await leave.save();
    res.json({ success: true, message: 'Leave request submitted', leave });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: GET /api/leaves/pending
app.get('/api/leaves/pending', async (req, res) => {
  try {
    const leavesCol = getColName('leave_requests', req);
    const snapshot = await db.collection(leavesCol)
      .where('status', '==', 'pending')
      .get();
    const leaves = [];
    snapshot.forEach(doc => leaves.push(doc.data()));
    res.json({ success: true, leaves });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/leaves/:requestId/approve
app.post('/api/leaves/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { days } = req.body;
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    
    if (!days || isNaN(days) || days <= 0) {
      return res.status(400).json({ success: false, error: 'Valid number of days required' });
    }

    const leave = await LeaveRequest.getById(requestId, adminEmail);
    if (!leave) {
      return res.status(404).json({ success: false, error: 'Leave request not found' });
    }

    const start = new Date();
    const end = new Date(start.getTime() + (parseInt(days) - 1) * 24 * 60 * 60 * 1000);
    
    leave.startDate = getLocalDateString(start);
    leave.endDate = getLocalDateString(end);
    leave.status = 'approved';

    await leave.save();

    const empCol = getColName('employees', req);
    const empDoc = await db.collection(empCol).doc(leave.employeeId.replace(/\//g, '-')).get();
    const empNameAndId = empDoc.exists ? `${empDoc.data().name} (${leave.employeeId})` : leave.employeeId;

    const logsCol = getColName('logs', req);
    await db.collection(logsCol).add({
      type: 'system',
      name: 'Leave Approved',
      message: `Leave request for ${empNameAndId} (${leave.type}) approved for ${days} days.`,
      status: 'granted',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Leave request approved successfully', leave });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/leaves/:requestId/decline
app.post('/api/leaves/:requestId/decline', async (req, res) => {
  try {
    const { requestId } = req.params;
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const leave = await LeaveRequest.getById(requestId, adminEmail);
    if (!leave) {
      return res.status(404).json({ success: false, error: 'Leave request not found' });
    }

    leave.status = 'rejected';
    await leave.save();

    const empCol = getColName('employees', req);
    const empDoc = await db.collection(empCol).doc(leave.employeeId.replace(/\//g, '-')).get();
    const empNameAndId = empDoc.exists ? `${empDoc.data().name} (${leave.employeeId})` : leave.employeeId;

    const logsCol = getColName('logs', req);
    await db.collection(logsCol).add({
      type: 'system',
      name: 'Leave Request Declined',
      message: `Leave request for ${empNameAndId} (${leave.type}) has been declined.`,
      status: 'denied',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Leave request declined successfully', leave });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/analytics/generate-alerts
app.post('/api/analytics/generate-alerts', async (req, res) => {
  try {
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const alerts = await PredictiveAnalyticsEngine.generateAlerts(adminEmail);
    res.json({ success: true, message: 'Alerts generated', count: alerts.length, alerts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: GET /api/analytics/alerts
app.get('/api/analytics/alerts', async (req, res) => {
  try {
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const alerts = await PredictiveAnalyticsEngine.getActiveAlerts(adminEmail);
    res.json({ success: true, alerts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: GET /api/analytics/employee/:employeeId
app.get('/api/analytics/employee/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const analytics = await PredictiveAnalyticsEngine.analyzeEmployeeHistory(employeeId, adminEmail);
    res.json({ success: true, analytics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check for Railway/Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', modelsLoaded: true, timestamp: new Date().toISOString() });
});

// Health check and Homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Backend Cron Job for Automated Session Closing
// Tracks which admin+date combos have already been processed to avoid duplicates
const processedSessionEnds = new Set();

cron.schedule('* * * * *', async () => {
  try {
    const adminsSnap = await db.collection('admins').get();
    if (adminsSnap.empty) return;
    
    const nowUtc = new Date();
    
    for (const doc of adminsSnap.docs) {
      try {
        const adminData = doc.data();
        const adminEmail = doc.id;
        if (!adminData.workHoursEnd) continue;
        
        const tzOffset = adminData.timezoneOffset || 0;
        const localNow = new Date(nowUtc.getTime() - (tzOffset * 60000));
        const currentH = localNow.getUTCHours();
        const currentM = localNow.getUTCMinutes();
        const currentTimeStr = `${currentH.toString().padStart(2, '0')}:${currentM.toString().padStart(2, '0')}`;
        
        if (currentTimeStr === adminData.workHoursEnd) {
          const todayStr = localNow.toISOString().split('T')[0];
          const processKey = `${adminEmail}_${todayStr}`;
          
          // Skip if already processed for this admin+date
          if (processedSessionEnds.has(processKey)) continue;
          processedSessionEnds.add(processKey);
          
          console.log(`[CRON] End of work hours detected for ${adminEmail} at ${currentTimeStr}. Generating daily report...`);
          
          // Generate the report
          await generateDailyReportCore(adminEmail, todayStr, null);
          console.log(`[CRON] Daily report generated for ${adminEmail} (${todayStr}).`);
          
          // Send Push Notification
          if (adminData.pushToken && Expo.isExpoPushToken(adminData.pushToken)) {
            await expo.sendPushNotificationsAsync([{
              to: adminData.pushToken,
              sound: 'default',
              title: "⏰ Workday Complete!",
              body: "The scheduled work hours have ended. The Daily Report has been generated automatically.",
              data: { screen: 'Report' },
            }]).catch(err => console.error('[CRON] Push notification failed:', err));
            console.log(`[CRON] Push notification sent to ${adminEmail}.`);
          }
        }
      } catch (innerErr) {
        console.error(`[CRON] Error processing admin ${doc.id}:`, innerErr.message);
      }
    }
    
    // Clean up old entries from processedSessionEnds (keep only today's)
    const todayPrefix = nowUtc.toISOString().split('T')[0];
    for (const key of processedSessionEnds) {
      if (!key.endsWith(todayPrefix)) processedSessionEnds.delete(key);
    }
  } catch (err) {
    // Silently handle network errors to avoid log spam during connectivity issues
    if (err.code === 14 || err.message?.includes('EHOSTUNREACH')) {
      // Network unreachable — skip this tick silently
    } else {
      console.error('[CRON] Automated session job failed:', err.message);
    }
  }
});

// Server Startup
async function startServer() {
  console.log('[SYSTEM] Starting backend server...');

  try {
    const server = app.listen(PORT, () => {
      console.log(`[SYSTEM] Server running on http://localhost:${PORT}`);
      console.log('[SYSTEM] Endpoints ready for incoming requests.');
      server.keepAliveTimeout = 120000;
      server.headersTimeout = 125000;

      if (!process.env.RAILWAY_ENVIRONMENT && !process.env.RENDER && !process.env.RAILWAY_PROJECT_ID) {
        try {
          const net = require('net');
          const PROXY_PORT = 5006;
          const proxy = net.createServer((clientSocket) => {
            const targetSocket = net.connect(PORT, '127.0.0.1');
            clientSocket.pipe(targetSocket);
            targetSocket.pipe(clientSocket);
            clientSocket.on('error', () => {});
            targetSocket.on('error', () => {});
          });
          proxy.listen(PROXY_PORT, '127.0.0.1', () => {
            console.log(`[PROXY] TCP Proxy Bridge running on port ${PROXY_PORT} -> ${PORT}\n`);
          });
        } catch (e) {
          console.warn('[PROXY] Proxy skipped:', e.message);
        }
      }
    });

    const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.RAILWAY_PROJECT_ID);
    if (isCloud) {
      console.log('[SYSTEM] Cloud mode — AI models will load on first face scan.');
    } else {
      try {
        await loadModels();
        console.log('[DB] Pre-loading employee database...');
        await getEmployeesFromCache();
        console.log('[SYSTEM] All systems ready.\n');
      } catch (err) {
        console.warn('[WARN] Model pre-load failed, will retry on demand:', err.message);
      }
    }
  } catch (error) {
    console.error('[ERROR] Server startup error:', error.message);
  }
}

startServer();
