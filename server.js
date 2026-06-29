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
      const todayStr = getLocalDateString(new Date());
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
    const { employeeId, faceDistanceScore, workHoursStart, workHoursEnd, captureTime } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId required' });
    
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const record = await AttendanceRecord.clockIn(employeeId, faceDistanceScore, workHoursStart, workHoursEnd, captureTime, adminEmail);
    res.json({ success: true, message: 'Clocked in successfully', record });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: POST /api/attendance/clock-out
app.post('/api/attendance/clock-out', async (req, res) => {
  try {
    const { employeeId, workHoursEnd } = req.body;
    if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId required' });
    
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();
    const record = await AttendanceRecord.clockOut(employeeId, workHoursEnd, adminEmail);
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

// Endpoint: POST /api/reports/generate-daily
// Calculates missing clock-outs and absences for the day.
app.post('/api/reports/generate-daily', async (req, res) => {
  try {
    const { date } = req.body; // YYYY-MM-DD
    const targetDate = date || getLocalDateString(new Date());
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();

    const empCol = getColName('employees', req);
    const attCol = getColName('attendance_logs', req);
    const leavesCol = getColName('leave_requests', req);
    const repCol = getColName('daily_reports', req);
    const logsCol = getColName('logs', req);

    console.log(`[API] Generating daily report for ${targetDate} (Admin: ${adminEmail})...`);

    // 1. Get all employees
    const employeesSnap = await db.collection(empCol).get();
    const employees = [];
    employeesSnap.forEach(doc => employees.push(doc.data()));

    // 2. Get today's attendance logs — collect ALL sessions per employee
    const attendanceSnap = await db.collection(attCol)
      .where('date', '==', targetDate)
      .get();
    
    const attendanceByEmp = {};
    attendanceSnap.forEach(doc => {
      const data = doc.data();
      if (data.status === 'absent' && !data.clockInTime) return;
      if (!attendanceByEmp[data.employeeId]) {
        attendanceByEmp[data.employeeId] = [];
      }
      attendanceByEmp[data.employeeId].push(data);
    });

    // Query approved leave requests that cover this targetDate
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

    // 3. Evaluate each employee
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
              logId: `LEAVE-${targetDate}-${emp.employeeId}`,
              employeeId: emp.employeeId,
              date: targetDate,
              status: leaveType,
              totalHours: 0,
              latenessMinutes: 0,
              type: 'attendance',
              adminEmail: adminEmail
            }).catch(console.error);
          }

        } else {
          report.absent++;
          for (let i = 1; i <= maxSessionsForDay; i++) {
            report.details.push({ employeeId: emp.employeeId, name: emp.name, status: 'absent', session: i });
          }
          
          if (shouldSave) {
            db.collection(attCol).doc(`ABSENT-${targetDate}-${emp.employeeId}`).set({
              logId: `ABSENT-${targetDate}-${emp.employeeId}`,
              employeeId: emp.employeeId,
              date: targetDate,
              status: 'absent',
              totalHours: 0,
              latenessMinutes: 0,
              type: 'attendance',
              adminEmail: adminEmail
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
            employeeId: emp.employeeId, 
            name: emp.name, 
            status: log.status,
            clockInTime: clockInISO,
            clockOutTime: clockOutISO,
            totalHours: log.totalHours || 0,
            session: idx + 1,
            totalSessionsForEmployee: sessions.length,
            logId: log.logId
          });
        });

        for (let i = sessions.length + 1; i <= maxSessionsForDay; i++) {
          report.details.push({
            employeeId: emp.employeeId,
            name: emp.name,
            status: 'absent',
            session: i,
            totalSessionsForEmployee: sessions.length
          });
        }
      }
    });

    if (shouldSave) {
      await db.collection(repCol).doc(targetDate).set(report);
      
      await db.collection(logsCol).add({
        type: 'report',
        name: 'Daily Report',
        message: `Daily attendance report for ${targetDate}: ${report.present} present, ${report.absent} absent, ${report.late} late, ${report.totalSessions} total sessions.`,
        status: 'granted',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ success: true, report });
  } catch (error) {
    console.error('[ERROR] Daily report error:', error.message);
    res.status(500).json({ success: false, error: 'Server error: ' + error.message });
  }
});

// Endpoint: GET /api/reports/monthly
// Gets aggregated stats for the current month
app.get('/api/reports/monthly', async (req, res) => {
  try {
    const { monthPrefix, workHoursEnd } = req.query; // YYYY-MM and HH:MM
    const prefix = monthPrefix || new Date().toISOString().substring(0, 7);
    const endHoursStr = workHoursEnd || '17:00';
    
    console.log(`[API] Fetching monthly report for ${prefix} (workHoursEnd: ${endHoursStr})...`);

    const [yearStr, monthStr] = prefix.split('-');
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);

    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ success: false, error: 'Invalid month format. Expected YYYY-MM.' });
    }

    const empCol = getColName('employees', req);
    const attCol = getColName('attendance_logs', req);
    const leavesCol = getColName('leave_requests', req);

    const employeesSnap = await db.collection(empCol).get();
    const employees = [];
    employeesSnap.forEach(doc => {
      const data = doc.data();
      employees.push({
        employeeId: data.employeeId,
        name: data.name
      });
    });

    const totalEmployees = employees.length;

    const workingDaysList = [];
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${prefix}-${String(day).padStart(2, '0')}`;
      const dateObj = new Date(year, month - 1, day);
      const dayOfWeek = dateObj.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        workingDaysList.push(dateStr);
      }
    }
    const workingDays = workingDaysList.length;
    const expectedAttendance = totalEmployees * workingDays;

    const startOfMonth = `${prefix}-01`;
    const endOfMonth = `${prefix}-${String(daysInMonth).padStart(2, '0')}`;
    
    const logsSnapshot = await db.collection(attCol)
      .where('date', '>=', startOfMonth)
      .where('date', '<=', endOfMonth)
      .get();

    const logs = [];
    logsSnapshot.forEach(doc => {
      logs.push(doc.data());
    });

    const logsByEmployeeAndDate = {};
    logs.forEach(log => {
      const empId = log.employeeId;
      const date = log.date;
      if (!logsByEmployeeAndDate[empId]) {
        logsByEmployeeAndDate[empId] = {};
      }
      if (!logsByEmployeeAndDate[empId][date]) {
        logsByEmployeeAndDate[empId][date] = [];
      }
      logsByEmployeeAndDate[empId][date].push(log);
    });

    const leavesSnapshot = await db.collection(leavesCol)
      .where('status', '==', 'approved')
      .get();

    const approvedLeaves = [];
    leavesSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.startDate <= endOfMonth && data.endDate >= startOfMonth) {
        approvedLeaves.push(data);
      }
    });

    const leavesByEmployee = {};
    approvedLeaves.forEach(leave => {
      const empId = leave.employeeId;
      if (!leavesByEmployee[empId]) {
        leavesByEmployee[empId] = [];
      }
      leavesByEmployee[empId].push(leave);
    });

    const isEarlyDeparture = (clockOutDate, workHoursEndStr) => {
      if (!clockOutDate) return false;
      const [endH, endM] = workHoursEndStr.split(':').map(Number);
      const hour = clockOutDate.getHours();
      const minute = clockOutDate.getMinutes();
      if (hour < endH) return true;
      if (hour === endH && minute < endM) return true;
      return false;
    };

    const employeeStats = [];
    let totalPresentDays = 0;
    let totalAbsentDays = 0;
    let totalLateArrivals = 0;
    let totalEarlyDepartures = 0;
    let totalSickLeaves = 0;
    let totalAnnualLeaves = 0;
    let totalRemoteWorks = 0;

    const dailyPresentCounts = {};
    workingDaysList.forEach(d => {
      dailyPresentCounts[d] = 0;
    });

    const weeklyLateCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    employees.forEach(emp => {
      const empId = emp.employeeId;
      const empLogs = logsByEmployeeAndDate[empId] || {};
      const empLeaves = leavesByEmployee[empId] || [];

      let presentDays = 0;
      let absentDays = 0;
      let lateDays = 0;
      let lateSessions = 0;
      let earlyDeps = 0;
      let sickDays = 0;
      let annualDays = 0;
      let remoteDays = 0;

      workingDaysList.forEach(d => {
        const dayLogs = empLogs[d] || [];
        const hasClockIn = dayLogs.some(log => log.clockInTime && log.status !== 'absent');

        if (hasClockIn) {
          presentDays++;
          dailyPresentCounts[d]++;
          
          dayLogs.forEach(log => {
            if (log.status === 'late' || (log.latenessMinutes && log.latenessMinutes > 0)) {
              lateSessions++;
              
              const dayOfMonth = parseInt(d.split('-')[2]);
              let weekNum = 5;
              if (dayOfMonth <= 7) weekNum = 1;
              else if (dayOfMonth <= 14) weekNum = 2;
              else if (dayOfMonth <= 21) weekNum = 3;
              else if (dayOfMonth <= 28) weekNum = 4;
              
              weeklyLateCounts[weekNum]++;
            }
          });

          const isLateOnDay = dayLogs.some(log => log.status === 'late' || (log.latenessMinutes && log.latenessMinutes > 0));
          if (isLateOnDay) {
            lateDays++;
          }

          let finalClockOut = null;
          dayLogs.forEach(log => {
            if (log.clockOutTime) {
              const outDate = log.clockOutTime.toDate ? log.clockOutTime.toDate() : new Date(log.clockOutTime);
              if (!finalClockOut || outDate > finalClockOut) {
                finalClockOut = outDate;
              }
            }
          });

          if (finalClockOut && isEarlyDeparture(finalClockOut, endHoursStr)) {
            earlyDeps++;
            totalEarlyDepartures++;
          }

        } else {
          const activeLeave = empLeaves.find(l => l.startDate <= d && l.endDate >= d);
          if (activeLeave) {
            const type = activeLeave.type;
            if (type === 'sick') {
              sickDays++;
              totalSickLeaves++;
            } else if (type === 'vacation' || type === 'personal' || type === 'annual') {
              annualDays++;
              totalAnnualLeaves++;
            } else if (type === 'remote' || type === 'wfh' || type === 'work_from_home') {
              remoteDays++;
              totalRemoteWorks++;
            } else {
              annualDays++;
              totalAnnualLeaves++;
            }
          } else {
            const hasAbsentLog = dayLogs.some(log => log.status === 'absent');
            if (hasAbsentLog) {
              absentDays++;
              totalAbsentDays++;
            }
          }
        }
      });

      totalPresentDays += presentDays;
      totalLateArrivals += lateSessions;

      const attendanceRate = workingDays > 0 ? (presentDays / workingDays) * 100 : 0;
      const leaveDays = sickDays + annualDays;

      employeeStats.push({
        employeeId: empId,
        name: emp.name,
        presentDays,
        absentDays,
        lateDays,
        lateArrivals: lateSessions,
        earlyDepartures: earlyDeps,
        leaveDays,
        sickDays,
        annualDays,
        remoteDays,
        attendanceRate: parseFloat(attendanceRate.toFixed(2))
      });
    });

    const overallAttendanceRate = expectedAttendance > 0 ? (totalPresentDays / expectedAttendance) * 100 : 0;

    const sortedEmployees = [...employeeStats].sort((a, b) => b.attendanceRate - a.attendanceRate);
    let topPerformers = [];
    const perfectAttendanceEmps = sortedEmployees.filter(emp => emp.attendanceRate === 100);
    if (perfectAttendanceEmps.length >= 5) {
      topPerformers = perfectAttendanceEmps;
    } else {
      topPerformers = sortedEmployees.slice(0, Math.max(5, perfectAttendanceEmps.length));
    }

    const requiringAttention = employeeStats.filter(emp => {
      return emp.attendanceRate < 80 || emp.absentDays > 3 || emp.lateArrivals > 5;
    }).map(emp => {
      const issues = [];
      if (emp.attendanceRate < 80) issues.push(`Attendance below 80% (${emp.attendanceRate.toFixed(2)}%)`);
      if (emp.absentDays > 3) issues.push(`Absences > 3 (${emp.absentDays} days)`);
      if (emp.lateArrivals > 5) issues.push(`Late Arrivals > 5 (${emp.lateArrivals} times)`);
      return {
        ...emp,
        reason: issues.join(', ')
      };
    });

    const dailyTrendLabels = workingDaysList;
    const dailyTrendData = workingDaysList.map(d => {
      const count = dailyPresentCounts[d] || 0;
      const rate = totalEmployees > 0 ? (count / totalEmployees) * 100 : 0;
      return parseFloat(rate.toFixed(2));
    });

    const weeklyLateData = [
      weeklyLateCounts[1],
      weeklyLateCounts[2],
      weeklyLateCounts[3],
      weeklyLateCounts[4],
      weeklyLateCounts[5]
    ];

    const logsCol = getColName('logs', req);
    await db.collection(logsCol).add({
      type: 'report',
      name: 'Monthly HR Report',
      message: `Monthly attendance summary for ${prefix}: Analyzed performance for ${totalEmployees} employees. Overall rate: ${overallAttendanceRate.toFixed(2)}%`,
      status: 'granted',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      month: prefix,
      summary: {
        totalEmployees,
        workingDays,
        expectedAttendance,
        presentDays: totalPresentDays,
        absentDays: totalAbsentDays,
        lateArrivals: totalLateArrivals,
        earlyDepartures: totalEarlyDepartures,
        sickLeaves: totalSickLeaves,
        annualLeaves: totalAnnualLeaves,
        remoteWorks: totalRemoteWorks,
        attendanceRate: parseFloat(overallAttendanceRate.toFixed(2))
      },
      employeeReport: employeeStats,
      stats: employeeStats,
      statusDistribution: {
        present: totalPresentDays,
        absent: totalAbsentDays,
        sickLeave: totalSickLeaves,
        annualLeave: totalAnnualLeaves,
        remoteWork: totalRemoteWorks
      },
      topPerformers,
      requiringAttention,
      dailyTrend: {
        labels: dailyTrendLabels,
        data: dailyTrendData
      },
      weeklyLates: {
        labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'],
        data: weeklyLateData
      }
    });

  } catch (error) {
    console.error('[ERROR] Monthly report error:', error.message);
    res.status(500).json({ success: false, error: 'Server error: ' + error.message });
  }
});

// Endpoint: DELETE /delete-employee/:id
// Delete an employee from Firestore
app.delete('/delete-employee/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Firestore not connected. Check Firebase configuration.'
      });
    }

    const employeeId = req.params.id;
    const docId = employeeId.replace(/\//g, '-');
    const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase();

    console.log(`[API] Deleting employee: ${employeeId} (Admin: ${adminEmail})`);

    const empCol = getColName('employees', req);
    const docRef = db.collection(empCol).doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        error: `Employee with ID "${employeeId}" not found.`
      });
    }

    await docRef.delete();
    invalidateEmployeeCache(adminEmail);
    console.log(`[DB] Employee deleted: ${docId} from ${empCol}`);

    res.json({
      success: true,
      message: `Employee "${employeeId}" has been deleted.`
    });

  } catch (error) {
    console.error('[ERROR] Delete employee error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error deleting employee: ' + error.message
    });
  }
});

// Endpoint: GET /api/schedules/:employeeId
app.get('/api/schedules/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const colName = getColName('schedules', req);
    const snapshot = await db.collection(colName).where('employeeId', '==', employeeId).get();
    const schedules = [];
    snapshot.forEach(doc => schedules.push(doc.data()));
    res.json({ success: true, schedules });
  } catch (error) {
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

// Health check and Homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server Startup
async function startServer() {
  console.log('[SYSTEM] Starting backend server...');

  try {
    // Load AI models before accepting any requests
    await loadModels();

    // Pre-warm employee cache so first scan is instant
    console.log('[DB] Pre-loading employee database...');
    await getEmployeesFromCache();

    // Start Express server
    const server = app.listen(PORT, () => {
      console.log(`[SYSTEM] Server running on http://localhost:${PORT}`);

      // Prevent Localtunnel socket hangs
      server.keepAliveTimeout = 120000;
      server.headersTimeout = 125000;

      console.log('[SYSTEM] Endpoints ready for incoming requests.');

      // Start TCP proxy bridge on port 5006
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
    });
  } catch (error) {
    console.error('[ERROR] Server failed to start:', error.message);
    process.exit(1);
  }
}

startServer();
