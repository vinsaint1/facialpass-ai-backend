/**
 * ============================================================
 * FacialPass AI — Firebase Configuration
 * ============================================================
 * 
 * Initializes Firebase Admin SDK for server-side Firestore access.
 * 
 * Supports TWO methods of loading credentials:
 *  1. Local file: serviceAccountKey.json (for development)
 *  2. Environment variable: FIREBASE_SERVICE_ACCOUNT (for deployment)
 * 
 * ── For Local Development ──
 * Place your serviceAccountKey.json in the /backend directory
 * 
 * ── For Cloud Deployment (Render/Railway) ──
 * Set the FIREBASE_SERVICE_ACCOUNT environment variable to the
 * ENTIRE contents of the serviceAccountKey.json file (as a string)
 * 
 * ============================================================
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let db;

try {
  let serviceAccount;

  // ── Method 1: Environment variable (for cloud deployment) ──
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('🔥 Firebase: Using environment variable credentials');
  }
  // ── Method 2: Local JSON file (for development) ──
  else {
    const filePath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(filePath)) {
      serviceAccount = require(filePath);
      console.log('🔥 Firebase: Using local serviceAccountKey.json');
    }
  }

  if (serviceAccount) {
    // Initialize Firebase Admin with credentials
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    // Get a reference to Firestore
    db = admin.firestore();

    console.log('🔥 Firebase Admin SDK initialized successfully');
    console.log(`   Project: ${serviceAccount.project_id}`);
  } else {
    console.error('❌ No Firebase credentials found!');
    console.error('   Option 1: Place serviceAccountKey.json in /backend');
    console.error('   Option 2: Set FIREBASE_SERVICE_ACCOUNT env variable');
  }

} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  // Don't crash — allow server to start for testing
}

module.exports = { admin, db };
