const { db } = require('../firebaseConfig');
const Employee = require('./Employee');

class PayrollCalculator {
  static async generateMonthlyReport(employeeId, year, month, adminEmail = '') {
    // month is 1-12
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59); // Last day of month
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const employee = await Employee.getById(employeeId, adminEmail);
    if (!employee) throw new Error("Employee not found");

    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const attCol = cleanEmail ? `attendance_logs_${cleanEmail}` : 'attendance_logs';
    const payCol = cleanEmail ? `payroll_reports_${cleanEmail}` : 'payroll_reports';

    const snapshot = await db.collection(attCol)
      .where('employeeId', '==', employeeId)
      .where('date', '>=', startDateStr)
      .where('date', '<=', endDateStr)
      .get();

    let totalHoursWorked = 0;
    
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.clockOutTime) {
        totalHoursWorked += (data.totalHours || 0);
      }
    });

    // Standard monthly hours = 160 (40 * 4)
    const standardMonthlyHours = 160;
    let standardHours = totalHoursWorked;
    let overtimeHours = 0;

    if (totalHoursWorked > standardMonthlyHours) {
      standardHours = standardMonthlyHours;
      overtimeHours = totalHoursWorked - standardMonthlyHours;
    }

    const standardPay = standardHours * employee.hourlyRate;
    const overtimePay = overtimeHours * (employee.hourlyRate * 1.5);
    const grossPay = standardPay + overtimePay;

    const reportId = `PAY-${employeeId}-${year}-${month}`;
    const reportData = {
      reportId,
      employeeId,
      payPeriodStart: startDate,
      payPeriodEnd: endDate,
      totalHoursWorked,
      totalOvertimeHours: overtimeHours,
      grossPay,
      deductions: 0 // Additional deductions can be added here
    };

    await db.collection(payCol).doc(reportId).set(reportData);
    return reportData;
  }
}

module.exports = PayrollCalculator;
