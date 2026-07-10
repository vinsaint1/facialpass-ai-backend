const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// 1. Refactor generate-daily into a core function
const coreFunction = `
// Core daily report generation logic
async function generateDailyReportCore(adminEmail, targetDate, req) {
  const empCol = getColName('employees', adminEmail);
  const attCol = getColName('attendance_logs', adminEmail);
  const leavesCol = getColName('leave_requests', adminEmail);
  const repCol = getColName('daily_reports', adminEmail);
  const logsCol = getColName('logs', adminEmail);

  console.log(\`[CRON/API] Generating daily report for \${targetDate} (Admin: \${adminEmail})...\`);

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
          db.collection(attCol).doc(\`LEAVE-\${targetDate}-\${emp.employeeId}\`).set({
            logId: \`LEAVE-\${targetDate}-\${emp.employeeId}\`, employeeId: emp.employeeId, date: targetDate,
            status: leaveType, totalHours: 0, latenessMinutes: 0, type: 'attendance', adminEmail: adminEmail
          }).catch(console.error);
        }
      } else {
        report.absent++;
        for (let i = 1; i <= maxSessionsForDay; i++) {
          report.details.push({ employeeId: emp.employeeId, name: emp.name, status: 'absent', session: i });
        }
        if (shouldSave) {
          db.collection(attCol).doc(\`ABSENT-\${targetDate}-\${emp.employeeId}\`).set({
            logId: \`ABSENT-\${targetDate}-\${emp.employeeId}\`, employeeId: emp.employeeId, date: targetDate,
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
      message: \`Daily attendance report for \${targetDate}: \${report.present} present, \${report.absent} absent, \${report.late} late, \${report.totalSessions} total sessions.\`,
      status: 'granted', timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  return report;
}
`;

// Insert after the existing app.post('/api/reports/generate-daily' comment block but replace the logic inside it
const apiPattern = /\/\/ Endpoint: POST \/api\/reports\/generate-daily\s*\n\/\/ Calculates missing clock-outs and absences for the day\.\s*\napp\.post\('\/api\/reports\/generate-daily', async \(req, res\) => {[\s\S]*?res\.status\(500\)\.json\(\{ success: false, error: error\.message \}\);\s*\n  \}\s*\n\}\);/;

const newApiCode = `// Endpoint: POST /api/reports/generate-daily
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
});`;

content = content.replace(apiPattern, coreFunction + '\n\n' + newApiCode);

// 2. Add admin settings routes
const adminRoutes = `
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
`;

content = content.replace('// Endpoint: POST /api/reports/generate-daily', adminRoutes + '\n// Endpoint: POST /api/reports/generate-daily');

// 3. Add node-cron job at the end before startServer()
const cronJob = `
// Backend Cron Job for Automated Session Closing
cron.schedule('* * * * *', async () => {
  try {
    const adminsSnap = await db.collection('admins').get();
    const nowUtc = new Date();
    
    adminsSnap.forEach(async (doc) => {
      const adminData = doc.data();
      const adminEmail = doc.id;
      if (!adminData.workHoursEnd) return;
      
      const tzOffset = adminData.timezoneOffset || 0;
      const localNow = new Date(nowUtc.getTime() - (tzOffset * 60000));
      const currentH = localNow.getUTCHours();
      const currentM = localNow.getUTCMinutes();
      const currentTimeStr = \`\${currentH.toString().padStart(2, '0')}:\${currentM.toString().padStart(2, '0')}\`;
      
      if (currentTimeStr === adminData.workHoursEnd) {
        console.log(\`[CRON] End of work hours detected for \${adminEmail} at \${currentTimeStr}. Generating daily report...\`);
        const todayStr = getLocalDateString(localNow);
        
        // Generate the report
        await generateDailyReportCore(adminEmail, todayStr, null);
        
        // Send Push Notification
        if (adminData.pushToken && Expo.isExpoPushToken(adminData.pushToken)) {
          expo.sendPushNotificationsAsync([{
            to: adminData.pushToken,
            sound: 'default',
            title: "⏰ Workday Complete!",
            body: "The scheduled work hours have ended. The Daily Report has been generated automatically.",
            data: { screen: 'Report' },
          }]).catch(err => console.error('[CRON] Push notification failed:', err));
        }
      }
    });
  } catch (err) {
    console.error('[CRON] Automated session job failed:', err);
  }
});

`;

content = content.replace('// Server Startup', cronJob + '// Server Startup');

fs.writeFileSync('server.js', content);
console.log('Successfully updated server.js');
