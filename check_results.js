const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkResults() {
  const email = 'vinczokpa@gmail.com';
  const cleanEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  
  console.log("--- ADMIN SETTINGS ---");
  const adminDoc = await db.collection('admins').doc(email).get();
  console.log(adminDoc.data());

  console.log("\n--- DAILY REPORTS ---");
  const repCol = `daily_reports_${cleanEmail}`;
  const reps = await db.collection(repCol).get();
  reps.forEach(doc => console.log(doc.id, JSON.stringify(doc.data(), null, 2)));

  console.log("\n--- ATTENDANCE LOGS ---");
  const attCol = `attendance_logs_${cleanEmail}`;
  const atts = await db.collection(attCol).get();
  atts.forEach(doc => {
    const d = doc.data();
    console.log(doc.id, `Status: ${d.status}, Date: ${d.date}, In: ${d.clockInTime ? new Date(d.clockInTime._seconds*1000).toISOString() : 'none'}`);
  });

  process.exit(0);
}

checkResults().catch(console.error);
