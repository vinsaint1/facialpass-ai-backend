const { db } = require('../firebaseConfig');
const Schedule = require('./Schedule');

const getLocalDateString = (d = new Date()) => {
  const offset = d.getTimezoneOffset();
  const localDate = new Date(d.getTime() - (offset * 60 * 1000));
  return localDate.toISOString().split('T')[0];
};

class AttendanceRecord {
  constructor(logId, employeeId, date, clockInTime, clockOutTime, status, totalHours, faceDistanceScore, adminEmail) {
    this.logId = logId;
    this.employeeId = employeeId;
    this.date = date; // "YYYY-MM-DD"
    this.clockInTime = clockInTime;
    this.clockOutTime = clockOutTime || null;
    this.status = status || 'on_time';
    this.totalHours = totalHours || 0;
    this.faceDistanceScore = faceDistanceScore || null;
    this.adminEmail = adminEmail || '';
  }

  static async clockIn(employeeId, faceDistanceScore, workHoursStart, workHoursEnd, captureTimeStr, adminEmail = '', workHoursEnabled = false) {
    const now = captureTimeStr ? new Date(captureTimeStr) : new Date();
    
    if (workHoursEnabled && workHoursStart && workHoursEnd) {
      const [startH, startM] = workHoursStart.split(':').map(Number);
      const [endH, endM] = workHoursEnd.split(':').map(Number);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      
      if (nowMinutes < startMinutes || nowMinutes > endMinutes) {
        throw new Error("Clock-in is blocked outside work hours (Time-Gate active)");
      }
    }

    const dateStr = getLocalDateString(now);
    
    // Fetch employee to resolve parent adminEmail (tenancy)
    const Employee = require('./Employee');
    const emp = await Employee.getById(employeeId, adminEmail);
    const resolvedAdminEmail = adminEmail || (emp ? emp.adminEmail : '');

    const cleanEmail = resolvedAdminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `attendance_logs_${cleanEmail}` : 'attendance_logs';

    // Check if already clocked in but not clocked out
    const existing = await db.collection(colName)
      .where('employeeId', '==', employeeId)
      .where('date', '==', dateStr)
      .get();
    
    let isCurrentlyClockedIn = false;
    let activeDocId = null;
    existing.forEach(doc => {
      const data = doc.data();
      if (data.clockInTime && !data.clockOutTime) {
         isCurrentlyClockedIn = true;
         activeDocId = doc.id;
      }
    });

    if (isCurrentlyClockedIn && activeDocId) {
      // Automatically close the previous session so they can start a new one
      await db.collection(colName).doc(activeDocId).update({
        clockOutTime: now
      });
    }

    // Determine status based on global work hours
    let status = 'on_time';
    let latenessMinutes = 0;
    
    if (workHoursStart) {
      const [schedH, schedM] = workHoursStart.split(':').map(Number);
      const schedTime = new Date(now);
      schedTime.setHours(schedH, schedM, 0, 0);
      
      // 5 minute grace period for clocking in
      const graceTime = new Date(schedTime.getTime() + 5 * 60000);
      
      if (now > graceTime) {
        status = 'late';
        latenessMinutes = Math.floor((now - schedTime) / 60000);
      }
    }

    const logId = `LOG-${Date.now()}`;
    const record = new AttendanceRecord(
      logId, employeeId, dateStr, now, null, status, 0, faceDistanceScore, resolvedAdminEmail
    );
    
    // Store latenessMinutes temporarily for the object if we want
    record.latenessMinutes = latenessMinutes;
    
    await record.save();
    return record;
  }

  static async clockOut(employeeId, workHoursEnd, adminEmail = '', workHoursEnabled = false, workHoursStart = '') {
    const now = new Date();
    
    if (workHoursEnabled && workHoursStart && workHoursEnd) {
      const [startH, startM] = workHoursStart.split(':').map(Number);
      const [endH, endM] = workHoursEnd.split(':').map(Number);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      
      if (nowMinutes < startMinutes || nowMinutes > endMinutes) {
        throw new Error("Clock-out is blocked outside work hours (Time-Gate active)");
      }
    }

    const dateStr = getLocalDateString(now);
    
    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `attendance_logs_${cleanEmail}` : 'attendance_logs';

    const existing = await db.collection(colName)
      .where('employeeId', '==', employeeId)
      .where('date', '==', dateStr)
      .get();
      
    if (existing.empty) {
      throw new Error("No clock-in record found for today");
    }

    // Find the active session (not clocked out yet)
    let activeDoc = null;
    existing.forEach(doc => {
      const data = doc.data();
      if (data.clockInTime && !data.clockOutTime) activeDoc = doc;
    });

    if (!activeDoc) {
      throw new Error("Already clocked out for all sessions today");
    }

    const data = activeDoc.data();

    const clockInDate = data.clockInTime.toDate ? data.clockInTime.toDate() : new Date(data.clockInTime);
    let diffHours = (now - clockInDate) / 3600000;
    
    // Ensure diffHours is never negative just in case
    diffHours = Math.max(0, diffHours);
    
    let currentStatus = data.status;
    
    // 5 minute grace period for clock out
    if (workHoursEnd) {
      const [endH, endM] = workHoursEnd.split(':').map(Number);
      const schedEndTime = new Date(now);
      schedEndTime.setHours(endH, endM, 0, 0);
      
      // "5 minutes after work hours end is considered late"
      const graceTimeOut = new Date(schedEndTime.getTime() + 5 * 60000);
      
      if (now > graceTimeOut) {
        currentStatus = 'late';
      }
    }
    
    const record = new AttendanceRecord(
      data.logId, data.employeeId, data.date, clockInDate, now, currentStatus, diffHours, data.faceDistanceScore, data.adminEmail || ''
    );
    
    await record.save();
    return record;
  }

  async save() {
    const cleanEmail = (this.adminEmail || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `attendance_logs_${cleanEmail}` : 'attendance_logs';
    await db.collection(colName).doc(this.logId).set({
      logId: this.logId,
      employeeId: this.employeeId,
      date: this.date,
      clockInTime: this.clockInTime,
      clockOutTime: this.clockOutTime,
      status: this.status,
      totalHours: this.totalHours,
      faceDistanceScore: this.faceDistanceScore,
      latenessMinutes: this.latenessMinutes || 0,
      adminEmail: this.adminEmail
    });
  }
}

module.exports = AttendanceRecord;
