/**
 * ============================================================
 * FacialPass AI — Post-Install Setup
 * ============================================================
 * 
 * Runs automatically after `npm install` to:
 * 1. Create a @tensorflow/tfjs-node stub (redirects to pure-JS tfjs)
 * 2. Copy AI models from @vladmandic/face-api to /models
 * 
 * This ensures the backend works on any Node.js version (18+)
 * without requiring native C++ compilation.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ── Step 1: Create tfjs-node stub ──
const stubDir = path.join(__dirname, 'node_modules', '@tensorflow', 'tfjs-node');

if (!fs.existsSync(stubDir)) {
  fs.mkdirSync(stubDir, { recursive: true });
}

const stubIndex = path.join(stubDir, 'index.js');
if (!fs.existsSync(stubIndex)) {
  fs.writeFileSync(stubIndex, `module.exports = require('@tensorflow/tfjs');\n`);
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
    name: '@tensorflow/tfjs-node',
    version: '4.22.0',
    description: 'Stub redirecting to pure-JS @tensorflow/tfjs',
    main: 'index.js'
  }, null, 2));
  console.log('✅ Created @tensorflow/tfjs-node stub');
}

// ── Step 2: Copy models ──
const sourceDir = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api', 'model');
const modelsDir = path.join(__dirname, 'models');

if (fs.existsSync(sourceDir)) {
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const needed = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'ssd_mobilenetv1_model.bin',
    'face_landmark_68_model-weights_manifest.json',
    'face_landmark_68_model.bin',
    'face_recognition_model-weights_manifest.json',
    'face_recognition_model.bin',
  ];

  let copied = 0;
  for (const f of needed) {
    const src = path.join(sourceDir, f);
    const dest = path.join(modelsDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied++;
    }
  }
  if (copied > 0) console.log(`✅ Copied ${copied} model files to /models`);
}

console.log('✅ Post-install setup complete');
