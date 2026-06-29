const { db } = require('../firebaseConfig');

class Employee {
  constructor(employeeId, name, email, role, hourlyRate, embeddings, registeredAt, adminEmail) {
    this.employeeId = employeeId;
    this.name = name;
    this.email = email;
    this.role = role || 'employee';
    this.hourlyRate = hourlyRate || 0;
    this.embeddings = embeddings || [];
    this.registeredAt = registeredAt || new Date();
    this.adminEmail = adminEmail || '';
  }

  static async getById(employeeId, adminEmail = '') {
    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `employees_${cleanEmail}` : 'employees';
    const doc = await db.collection(colName).doc(employeeId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return new Employee(
      data.employeeId, data.name, data.email, data.role,
      data.hourlyRate, data.embeddings, data.registeredAt, data.adminEmail
    );
  }

  async save() {
    const cleanEmail = (this.adminEmail || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const colName = cleanEmail ? `employees_${cleanEmail}` : 'employees';
    await db.collection(colName).doc(this.employeeId).set({
      employeeId: this.employeeId,
      name: this.name,
      email: this.email,
      role: this.role,
      hourlyRate: this.hourlyRate,
      embeddings: this.embeddings,
      registeredAt: this.registeredAt,
      adminEmail: this.adminEmail
    });
  }
}

module.exports = Employee;
