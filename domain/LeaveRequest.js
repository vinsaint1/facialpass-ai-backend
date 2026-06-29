const { db } = require('../firebaseConfig');

class LeaveRequest {
  constructor(requestId, employeeId, startDate, endDate, type, status, reason, adminEmail) {
    this.requestId = requestId;
    this.employeeId = employeeId;
    this.startDate = startDate; // "YYYY-MM-DD"
    this.endDate = endDate; // "YYYY-MM-DD"
    this.type = type; // "sick" | "vacation" | "personal"
    this.status = status || "pending"; // "pending" | "approved" | "rejected"
    this.reason = reason || "";
    this.adminEmail = adminEmail || "";
  }

  static async getById(requestId, adminEmail = '') {
    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `leave_requests_${cleanEmail}` : 'leave_requests';
    const doc = await db.collection(colName).doc(requestId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return new LeaveRequest(
      data.requestId, data.employeeId, data.startDate,
      data.endDate, data.type, data.status, data.reason, data.adminEmail
    );
  }

  async save() {
    const cleanEmail = (this.adminEmail || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `leave_requests_${cleanEmail}` : 'leave_requests';
    await db.collection(colName).doc(this.requestId).set({
      requestId: this.requestId,
      employeeId: this.employeeId,
      startDate: this.startDate,
      endDate: this.endDate,
      type: this.type,
      status: this.status,
      reason: this.reason,
      adminEmail: this.adminEmail
    });
  }
}

module.exports = LeaveRequest;
