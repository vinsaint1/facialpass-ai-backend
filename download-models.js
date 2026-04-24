/**
 * ============================================================
 * FacialPass AI — Pre-trained Model Setup
 * ============================================================
 * 
 * This script copies the 3 required face-api.js models from the
 * @vladmandic/face-api npm package into the local /models directory.
 * 
 * Models included:
 *  1. ssd_mobilenetv1      — Face detection (finds faces in images)
 *  2. face_landmark_68     — Facial landmark detection (68 key points)
 *  3. face_recognition     — Face embedding extraction (128-float vector)
 * 
 * The models ship pre-bundled with @vladmandic/face-api, so no
 * external download is needed — we just copy them locally.
 * 
 * Usage: npm run download-models
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ── Source: models bundled inside the npm package ──
const SOURCE_DIR = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'model');

// ── Destination: local models directory ──
const MODELS_DIR = path.join(__dirname, 'models');

// ── The specific model files we need (3 models × 2 files each) ──
const REQUIRED_FILES = [
  // SSD MobileNetV1 — Face Detection
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model.bin',

  // Face Landmark 68 — Facial Landmark Detection
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',

  // Face Recognition — Embedding Extraction (128-float vector)
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

/**
 * Main function — copies model files from node_modules to /models
 */
function setupModels() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   FacialPass AI — Model Setup                ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Check that source exists (npm install must have been run)
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error('❌ Source models not found!');
    console.error('   Run "npm install" first to install @vladmandic/face-api');
    console.error(`   Expected: ${SOURCE_DIR}`);
    process.exit(1);
  }

  // Create models directory if it doesn't exist
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`📁 Created directory: ${MODELS_DIR}`);
  }

  console.log(`📦 Copying ${REQUIRED_FILES.length} model files...\n`);
  console.log(`   From: ${SOURCE_DIR}`);
  console.log(`   To:   ${MODELS_DIR}\n`);

  let copied = 0;
  let skipped = 0;

  for (const fileName of REQUIRED_FILES) {
    const srcPath = path.join(SOURCE_DIR, fileName);
    const destPath = path.join(MODELS_DIR, fileName);

    // Check source exists
    if (!fs.existsSync(srcPath)) {
      console.log(`  ❌ ${fileName} — not found in package`);
      continue;
    }

    // Skip if already copied
    if (fs.existsSync(destPath)) {
      const srcSize = fs.statSync(srcPath).size;
      const destSize = fs.statSync(destPath).size;
      if (srcSize === destSize) {
        console.log(`  ✅ ${fileName} (already exists, skipping)`);
        skipped++;
        continue;
      }
    }

    // Copy the file
    fs.copyFileSync(srcPath, destPath);
    const sizeMB = (fs.statSync(destPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  📄 ${fileName} (${sizeMB} MB) ✅`);
    copied++;
  }

  console.log(`\n🎉 Model setup complete!`);
  console.log(`   Copied: ${copied} | Skipped: ${skipped}`);
  console.log(`📂 Models ready at: ${MODELS_DIR}`);
  console.log('\nYou can now start the server with: npm start');
}

// Run setup
setupModels();
