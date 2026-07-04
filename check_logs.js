const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkLogs() {
  const email = 'vinczokpa@gmail.com';
  const cleanEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const targetCol = `attendance_logs_${cleanEmail}`;
  
  const snapshot = await db.collection(targetCol).get();
  console.log(`Found ${snapshot.size} records in ${targetCol}.`);
  
  snapshot.forEach(doc => {
    const data = doc.data();
    console.log(`Log ID: ${doc.id}, Employee: ${data.employeeId}, Date: ${data.date}, In: ${data.clockInTime ? new Date(data.clockInTime._seconds * 1000 || data.clockInTime).toISOString() : 'none'}, Out: ${data.clockOutTime ? new Date(data.clockOutTime._seconds * 1000 || data.clockOutTime).toISOString() : 'none'}`);
  });
  
  process.exit(0);
}

checkLogs().catch(err => {
  console.error(err);
  process.exit(1);
});
