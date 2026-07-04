const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkGlobalLogs() {
  const targetCol = 'attendance_logs';
  const todayStr = new Date().toISOString().split('T')[0];
  console.log(`Checking logs for global collection ${targetCol} on date ${todayStr}`);
  
  const snapshot = await db.collection(targetCol)
    .where('date', '==', todayStr)
    .get();
    
  console.log(`Found ${snapshot.size} records for today.`);
  snapshot.forEach(doc => {
    const data = doc.data();
    console.log(`ID: ${doc.id}`);
    console.log(`  EmployeeId: ${data.employeeId}`);
    console.log(`  AdminEmail: ${data.adminEmail}`);
    console.log(`  In: ${data.clockInTime ? (data.clockInTime.toDate ? data.clockInTime.toDate().toISOString() : new Date(data.clockInTime).toISOString()) : 'none'}`);
    console.log(`  Out: ${data.clockOutTime ? (data.clockOutTime.toDate ? data.clockOutTime.toDate().toISOString() : new Date(data.clockOutTime).toISOString()) : 'none'}`);
  });
  
  process.exit(0);
}

checkGlobalLogs().catch(console.error);
