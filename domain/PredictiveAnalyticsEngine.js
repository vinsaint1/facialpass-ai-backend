const { db } = require('../firebaseConfig');
const Employee = require('./Employee');

class PredictiveAnalyticsEngine {
  /**
   * Generates irregularity alerts for all employees based on their historical attendance.
   * This uses a heuristic/statistical approach.
   */
  static async generateAlerts(adminEmail = '') {
    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const empCol = cleanEmail ? `employees_${cleanEmail}` : 'employees';
    const predCol = cleanEmail ? `ai_predictions_${cleanEmail}` : 'ai_predictions';

    const employeesSnapshot = await db.collection(empCol).get();
    const alertsGenerated = [];

    for (const doc of employeesSnapshot.docs) {
      const employee = doc.data();
      const analytics = await this.analyzeEmployeeHistory(employee.employeeId, adminEmail);

      // Thresholds for generating an alert
      const needsAlert = analytics.predictedAbsenteeismProbability >= 50 || analytics.predictedTardinessProbability >= 50;

      if (needsAlert) {
        const predictionId = `ALERT-${employee.employeeId}-${Date.now()}`;
        const alertData = {
          predictionId,
          employeeId: employee.employeeId,
          name: employee.name,
          dateGenerated: new Date(),
          predictedAbsenteeismProbability: analytics.predictedAbsenteeismProbability,
          predictedTardinessProbability: analytics.predictedTardinessProbability,
          contributingFactors: analytics.contributingFactors,
          status: 'active' // admin can dismiss later
        };

        await db.collection(predCol).doc(predictionId).set(alertData);
        alertsGenerated.push(alertData);
      }
    }
    
    return alertsGenerated;
  }

  /**
   * Analyzes an individual employee's history to calculate probabilities and factors.
   */
  static async analyzeEmployeeHistory(employeeId, adminEmail = '') {
    // Fetch last 30 days of logs
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split('T')[0];

    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const attCol = cleanEmail ? `attendance_logs_${cleanEmail}` : 'attendance_logs';

    const logsSnapshot = await db.collection(attCol)
      .where('employeeId', '==', employeeId)
      .where('date', '>=', dateStr)
      .get();

    let totalDaysLogged = 0;
    let lateDays = 0;
    let totalLatenessMinutes = 0;
    let recentLateDays = 0; // within last 7 days

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    logsSnapshot.forEach(doc => {
      const data = doc.data();
      totalDaysLogged++;

      if (data.status === 'late') {
        lateDays++;
        totalLatenessMinutes += (data.latenessMinutes || 0);
        
        const logDate = new Date(data.date);
        if (logDate >= sevenDaysAgo) {
          recentLateDays++;
        }
      }
    });

    const factors = [];
    let tardinessProb = 0;
    let absenteeismProb = 0; // Requires deep schedule integration, simplified here

    if (totalDaysLogged > 0) {
      // Base probability based on historical rate
      const baseLateRate = (lateDays / totalDaysLogged) * 100;
      tardinessProb = baseLateRate;

      // Weight recent trends more heavily
      if (recentLateDays >= 2) {
        tardinessProb += 20; // Penalty
        factors.push(`Late ${recentLateDays} times in the last 7 days.`);
      }

      if (lateDays >= 5) {
        factors.push(`Frequent historical lateness (${lateDays} times in 30 days).`);
      }

      // Cap at 95%
      tardinessProb = Math.min(Math.round(tardinessProb), 95);
    } else {
      // No logs, high risk of absenteeism if they have been registered for a while
      factors.push("No attendance logs recorded in the last 30 days.");
      absenteeismProb = 80;
    }

    // Add a small baseline risk
    if (tardinessProb === 0 && totalDaysLogged > 0) tardinessProb = 5;
    if (absenteeismProb === 0 && totalDaysLogged > 0) absenteeismProb = 2;

    return {
      employeeId,
      predictedAbsenteeismProbability: absenteeismProb,
      predictedTardinessProbability: tardinessProb,
      contributingFactors: factors,
      metrics: {
        totalDaysLogged,
        lateDays,
        recentLateDays,
        totalLatenessMinutes
      }
    };
  }

  /**
   * Fetch active alerts
   */
  static async getActiveAlerts(adminEmail = '') {
    const cleanEmail = adminEmail.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const predCol = cleanEmail ? `ai_predictions_${cleanEmail}` : 'ai_predictions';

    const snapshot = await db.collection(predCol)
      .where('status', '==', 'active')
      .get();
      
    const alerts = [];
    snapshot.forEach(doc => alerts.push(doc.data()));

    // Sort in-memory to prevent requiring composite index creation
    alerts.sort((a, b) => {
      const tA = a.dateGenerated?.toDate ? a.dateGenerated.toDate().getTime() : new Date(a.dateGenerated || 0).getTime();
      const tB = b.dateGenerated?.toDate ? b.dateGenerated.toDate().getTime() : new Date(b.dateGenerated || 0).getTime();
      return tB - tA;
    });

    return alerts;
  }
}

module.exports = PredictiveAnalyticsEngine;
