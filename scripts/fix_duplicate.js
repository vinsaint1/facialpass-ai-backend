const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function fixDuplicateLog() {
  const email = 'vinczokpa@gmail.com';
  const cleanEmail = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const targetCol = `attendance_logs_${cleanEmail}`;
  
  // We saw LOG-1783100087602 is stuck open
  await db.collection(targetCol).doc('LOG-1783100087602').delete();
  console.log('Deleted stuck open log LOG-1783100087602');
  
  process.exit(0);
}

fixDuplicateLog().catch(err => {
  console.error(err);
  process.exit(1);
});
