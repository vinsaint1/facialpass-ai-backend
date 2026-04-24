/**
 * ============================================================
 * FacialPass AI — Face Engine (AI Core)
 * ============================================================
 * 
 * This is the heart of the facial recognition system.
 * It uses @vladmandic/face-api (a maintained fork of face-api.js)
 * with TensorFlow.js to:
 * 
 *  1. DETECT a face in an image (SSD MobileNetV1)
 *  2. LOCATE 68 facial landmarks (eyes, nose, mouth, jawline)
 *  3. EXTRACT a 128-float embedding vector (numerical "face fingerprint")
 * 
 * ── How Face Embeddings Work (Simple Explanation) ──
 * 
 * Think of it like this:
 * - Step 1: The AI finds the face in the photo (like drawing a box around it)
 * - Step 2: It maps 68 key points on the face (corners of eyes, tip of nose, etc.)
 * - Step 3: Using those points, it generates 128 numbers that uniquely describe
 *           that face. Two photos of the SAME person will generate very similar
 *           numbers. Two DIFFERENT people will generate very different numbers.
 * 
 * We store these 128 numbers (NOT the photo) in the database.
 * This is both more secure and more efficient than storing images.
 * 
 * ── Security Note ──
 * You CANNOT reverse-engineer a face from 128 numbers.
 * The embedding is a one-way mathematical transformation.
 * 
 * ── Technical Note ──
 * We use '@tensorflow/tfjs' (pure JavaScript) instead of '@tensorflow/tfjs-node'
 * for maximum compatibility — no native compilation required.
 * Images are decoded via 'sharp' into raw pixel tensors for face-api.
 * 
 * ============================================================
 */

const tf = require('@tensorflow/tfjs');
const faceapi = require('@vladmandic/face-api');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// ── Path to the downloaded model weight files ──
const MODELS_PATH = path.join(__dirname, '..', 'models');

// ── Track whether models are loaded ──
let modelsLoaded = false;

/**
 * loadModels()
 * 
 * Loads the 3 pre-trained neural network models from disk.
 * This only needs to happen once when the server starts.
 * Subsequent calls are no-ops (cached in memory).
 * 
 * Since we're using pure @tensorflow/tfjs (not tfjs-node),
 * we use loadFromDisk which reads model files directly.
 * 
 * Models loaded:
 *  - ssdMobilenetv1:       Detects face bounding boxes
 *  - faceLandmark68Net:    Locates 68 facial key points
 *  - faceRecognitionNet:   Generates 128-float embeddings
 */
async function loadModels() {
  if (modelsLoaded) {
    console.log('  ℹ️  Models already loaded, skipping...');
    return;
  }

  console.log('🧠 Loading AI models...');
  
  // Verify models directory exists
  if (!fs.existsSync(MODELS_PATH)) {
    throw new Error(`Models directory not found: ${MODELS_PATH}\nRun "npm run download-models" first.`);
  }

  try {
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_PATH);
    console.log('  ✅ SSD MobileNetV1 (Face Detection)');

    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
    console.log('  ✅ Face Landmark 68 (Facial Points)');

    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
    console.log('  ✅ Face Recognition (Embedding Extraction)');

    modelsLoaded = true;
    console.log('🎉 All models loaded successfully!\n');
  } catch (error) {
    console.error('❌ Failed to load models:', error.message);
    console.error('   Run "npm run download-models" first to download the weight files.');
    throw error;
  }
}

/**
 * imageBufferToTensor(imageBuffer)
 * 
 * Converts a raw image buffer (JPEG/PNG) into a TensorFlow.js
 * tensor that face-api.js can process.
 * 
 * Uses 'sharp' to decode the image into raw RGB pixel data,
 * then wraps it in a tf.tensor3d.
 * 
 * @param {Buffer} imageBuffer - Raw image file data
 * @returns {Promise<{tensor: tf.Tensor3D, width: number, height: number}>}
 */
async function imageBufferToTensor(imageBuffer) {
  // Use sharp to decode and get raw pixel data
  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()      // Convert to RGB (3 channels, no alpha)
    .raw()              // Get raw pixel buffer
    .toBuffer({ resolveWithObject: true });

  // Create a TensorFlow tensor from the raw pixel data
  // Shape: [height, width, 3] where 3 = RGB channels
  const tensor = tf.tensor3d(
    new Uint8Array(data),
    [info.height, info.width, 3],
    'int32'
  );

  return { tensor, width: info.width, height: info.height };
}

/**
 * extractEmbeddings(imageBuffer)
 * 
 * THE CORE FUNCTION — Takes a raw image buffer and returns
 * a 128-float array representing the face's unique embedding.
 * 
 * @param {Buffer} imageBuffer - Raw image data (JPEG/PNG buffer)
 * @returns {Promise<{
 *   success: boolean,
 *   embeddings: number[] | null,     // 128 floats if success
 *   error: string | null,
 *   confidence: number | null        // Detection confidence score
 * }>}
 * 
 * ── Pipeline ──
 * Image Buffer → Sharp decode → TF Tensor → Detect Face → Extract Landmarks → Generate Embedding
 */
async function extractEmbeddings(imageBuffer) {
  let tensorData = null;

  try {
    // Ensure models are loaded
    if (!modelsLoaded) {
      await loadModels();
    }

    // ── Step 1: Convert image buffer to TensorFlow tensor ──
    // Sharp decodes the JPEG/PNG into raw pixel data,
    // then we wrap it in a tensor for face-api to process
    tensorData = await imageBufferToTensor(imageBuffer);

    console.log(`  🖼️  Image: ${tensorData.width}x${tensorData.height}px`);

    // ── Step 2: Detect face + landmarks + compute embedding ──
    // This single chained call does all 3 steps:
    //   .detectSingleFace()              → finds the most prominent face
    //   .withFaceLandmarks()             → maps 68 key points
    //   .withFaceDescriptor()            → generates 128-float embedding
    const detection = await faceapi
      .detectSingleFace(tensorData.tensor, new faceapi.SsdMobilenetv1Options({
        minConfidence: 0.5  // Minimum 50% confidence to accept a face
      }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    // ── Step 3: Validate detection ──
    if (!detection) {
      return {
        success: false,
        embeddings: null,
        error: 'No face detected in the image. Please ensure your face is clearly visible, well-lit, and facing the camera.',
        confidence: null
      };
    }

    // ── Step 4: Extract the 128-float embedding array ──
    // detection.descriptor is a Float32Array of length 128
    // We convert it to a regular array for JSON serialization
    const embeddings = Array.from(detection.descriptor);
    const confidence = detection.detection.score;

    console.log(`  👤 Face detected with ${(confidence * 100).toFixed(1)}% confidence`);
    console.log(`  📊 Embedding: [${embeddings.slice(0, 3).map(n => n.toFixed(4)).join(', ')}... ] (128 values)`);

    return {
      success: true,
      embeddings: embeddings,  // Array of 128 floats
      error: null,
      confidence: confidence
    };

  } catch (error) {
    console.error('❌ Embedding extraction failed:', error.message);
    return {
      success: false,
      embeddings: null,
      error: `Processing error: ${error.message}`,
      confidence: null
    };
  } finally {
    // ── IMPORTANT: Dispose of the tensor to prevent memory leaks ──
    // TensorFlow tensors allocate native memory that the JS garbage
    // collector doesn't track. We must manually free it.
    if (tensorData && tensorData.tensor) {
      tensorData.tensor.dispose();
    }
  }
}

// ── Export the two main functions ──
module.exports = {
  loadModels,
  extractEmbeddings
};
