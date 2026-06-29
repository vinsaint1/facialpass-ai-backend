const { db } = require('../firebaseConfig');

class Schedule {
  constructor(scheduleId, employeeId, dayOfWeek, startTime, endTime, isOffDay, adminEmail) {
    this.scheduleId = scheduleId;
    this.employeeId = employeeId;
    this.dayOfWeek = dayOfWeek; // 0-6 (Sun-Sat)
    this.startTime = startTime; // "HH:MM"
    this.endTime = endTime; // "HH:MM"
    this.isOffDay = isOffDay || false;
    this.adminEmail = adminEmail || '';
  }

  static async getForEmployee(employeeId, dayOfWeek, adminEmail = '') {
    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `schedules_${cleanEmail}` : 'schedules';
    const snapshot = await db.collection(colName)
      .where('employeeId', '==', employeeId)
      .where('dayOfWeek', '==', dayOfWeek)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    const data = snapshot.docs[0].data();
    return new Schedule(
      data.scheduleId, data.employeeId, data.dayOfWeek,
      data.startTime, data.endTime, data.isOffDay, data.adminEmail
    );
  }

  async save() {
    const cleanEmail = (this.adminEmail || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `schedules_${cleanEmail}` : 'schedules';
    await db.collection(colName).doc(this.scheduleId).set({
      scheduleId: this.scheduleId,
      employeeId: this.employeeId,
      dayOfWeek: this.dayOfWeek,
      startTime: this.startTime,
      endTime: this.endTime,
      isOffDay: this.isOffDay,
      adminEmail: this.adminEmail
    });
  }
}

module.exports = Schedule;
