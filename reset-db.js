const { db, admin } = require('./firebaseConfig');

async function deleteCollection(collectionPath) {
  const collectionRef = db.collection(collectionPath);
  const query = collectionRef.orderBy('__name__').limit(500);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(db, query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(db, query, resolve) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    resolve();
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  process.nextTick(() => {
    deleteQueryBatch(db, query, resolve);
  });
}

async function resetDb() {
  // We keep 'users' intact so the admin can still log in
  const collections = [
    'employees', 
    'logs', 
    'schedules', 
    'attendance', 
    'leaves', 
    'payroll_reports', 
    'analytics_predictions'
  ];
  
  for (const col of collections) {
    console.log(`Deleting collection: ${col}`);
    await deleteCollection(col);
    console.log(`Successfully deleted collection: ${col}`);
  }
  console.log('Database reset complete. All data history cleared.');
  process.exit(0);
}

resetDb().catch(console.error);
