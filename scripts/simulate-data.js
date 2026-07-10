/**
 * ============================================================
 * FacialPass AI — Data Simulation Script
 * ============================================================
 * 
 * Generates 30 days of simulated attendance data for testing
 * the Predictive Analytics Engine and Payroll Calculator.
 * 
 * ============================================================
 */

require('dotenv').config();
const { db } = require('./firebaseConfig');
const AttendanceRecord = require('./domain/AttendanceRecord');

async function simulateData() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       FacialPass AI — Data Simulator         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    const employeesSnapshot = await db.collection('employees').get();
    
    if (employeesSnapshot.empty) {
      console.log('⚠️  No employees found! Please onboard an employee first.');
      process.exit(0);
    }

    console.log(`📋 Found ${employeesSnapshot.size} employee(s). Generating 30 days of history...`);

    let totalLogs = 0;
    const now = new Date();

    // Iterate over the last 30 days
    for (let i = 30; i >= 0; i--) {
      const simDate = new Date();
      simDate.setDate(now.getDate() - i);
      const dateStr = simDate.toISOString().split('T')[0];
      const dayOfWeek = simDate.getDay();

      // Skip weekends (0 = Sunday, 6 = Saturday)
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      // Create a log for each employee
      for (const doc of employeesSnapshot.docs) {
        const employee = doc.data();
        
        // Random chance of being late (20% chance)
        const isLate = Math.random() < 0.20;
        
        // Random chance of being absent entirely (5% chance)
        const isAbsent = Math.random() < 0.05;

        if (isAbsent) continue; // No log for today

        // Simulated Clock In Time
        const clockInTime = new Date(simDate);
        if (isLate) {
          // Late: Arrives between 09:15 and 10:30 (assuming 09:00 start)
          clockInTime.setHours(9, 15 + Math.floor(Math.random() * 75), 0);
        } else {
          // On Time: Arrives between 08:30 and 08:55
          clockInTime.setHours(8, 30 + Math.floor(Math.random() * 25), 0);
        }

        // Simulated Clock Out Time (Works ~8 hours)
        const clockOutTime = new Date(clockInTime);
        clockOutTime.setHours(clockInTime.getHours() + 8, Math.floor(Math.random() * 30), 0);

        const status = isLate ? 'late' : 'on_time';
        const totalHours = (clockOutTime - clockInTime) / 3600000; // milliseconds to hours
        const latenessMinutes = isLate ? Math.floor((clockInTime - new Date(simDate).setHours(9,0,0)) / 60000) : 0;
        const faceDistanceScore = 0.45 + (Math.random() * 0.1); // Simulated AI confidence score

        const logId = `SIM-${employee.employeeId}-${dateStr}`;

        await db.collection('attendance_logs').doc(logId).set({
          logId,
          employeeId: employee.employeeId,
          date: dateStr,
          clockInTime,
          clockOutTime,
          status,
          totalHours,
          faceDistanceScore,
          latenessMinutes
        });

        totalLogs++;
      }
    }

    console.log(`✅ Simulation Complete! Generated ${totalLogs} attendance logs.`);

    // Now trigger the Analytics Engine to analyze the new data!
    console.log('\n🧠 Triggering AI Predictive Analytics...');
    const PredictiveAnalyticsEngine = require('./domain/PredictiveAnalyticsEngine');
    const alerts = await PredictiveAnalyticsEngine.generateAlerts();
    
    console.log(`⚠️  AI generated ${alerts.length} Irregularity Alert(s) based on this new data!`);
    
    console.log('\n🎉 System is fully primed for Phase 4 Testing!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Simulation failed:', error);
    process.exit(1);
  }
}

simulateData();
