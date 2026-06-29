const tf = require('@tensorflow/tfjs');
const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');

// Intercept tfjs-node require for face-api compatibility on Windows environments
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(moduleName) {
  if (moduleName === '@tensorflow/tfjs-node') {
    return tf;
  }
  return originalRequire.apply(this, arguments);
};

const faceapi = require('@vladmandic/face-api');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const wasmDir = path.dirname(
  require.resolve('@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm')
);
setWasmPaths(wasmDir + '/');

const MODELS_PATH = path.join(__dirname, '..', 'models');
let modelsLoaded = false;

/**
 * Loads the face-api model weights from the local disk.
 * Initializes the WASM backend for TensorFlow.js and warms up the model tensors.
 */
async function loadModels() {
  if (modelsLoaded) {
    console.log('[AI] Models already loaded, skipping initialization.');
    return;
  }

  console.log('[AI] Loading neural network models...');
  
  if (!fs.existsSync(MODELS_PATH)) {
    throw new Error(`Models directory not found: ${MODELS_PATH}. Run download script first.`);
  }

  try {
    await tf.setBackend('wasm');
    await tf.ready();
    console.log(`[AI] TensorFlow backend initialized: ${tf.getBackend()}`);

    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH);
    console.log('[AI] Tiny Face Detector weights loaded.');

    await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(MODELS_PATH);
    console.log('[AI] Face Landmark 68 Tiny weights loaded.');

    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
    console.log('[AI] Face Recognition weights loaded.');

    modelsLoaded = true;
    console.log('[AI] Neural networks initialized successfully.');

    console.log('[AI] Warming up neural network models...');
    const dummyTensor = tf.zeros([224, 224, 3], 'int32');
    await faceapi
      .detectSingleFace(dummyTensor, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.1 }))
      .withFaceLandmarks(true)
      .withFaceDescriptor();
    dummyTensor.dispose();
    console.log('[AI] Models warmed up and ready.');
  } catch (error) {
    console.error('[ERROR] Failed to load models:', error.message);
    throw error;
  }
}

/**
 * Decodes and resizes an image buffer using sharp, then maps the raw pixel data to a 3D tensor.
 * @param {Buffer} imageBuffer - Raw binary image buffer
 * @returns {Promise<{tensor: tf.Tensor3D, width: number, height: number}>}
 */
async function imageBufferToTensor(imageBuffer) {
  const resized = await sharp(imageBuffer)
    .resize(224, 224, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(
    new Uint8Array(resized.data),
    [resized.info.height, resized.info.width, 3],
    'int32'
  );

  return { tensor, width: resized.info.width, height: resized.info.height };
}

/**
 * Extracts a 128-float face embedding vector from a binary image buffer.
 * @param {Buffer} imageBuffer - Raw image file data
 * @returns {Promise<{success: boolean, embeddings: number[]|null, error: string|null, confidence: number|null}>}
 */
async function extractEmbeddings(imageBuffer) {
  let tensorData = null;

  try {
    if (!modelsLoaded) {
      await loadModels();
    }

    tensorData = await imageBufferToTensor(imageBuffer);
    console.log(`[AI] Processing image buffer: ${tensorData.width}x${tensorData.height}px`);

    const detection = await faceapi
      .detectSingleFace(tensorData.tensor, new faceapi.TinyFaceDetectorOptions({
        inputSize: 224,
        scoreThreshold: 0.3
      }))
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    if (!detection) {
      return {
        success: false,
        embeddings: null,
        error: 'No face detected in the image. Ensure the face is clearly visible, well-lit, and facing the camera.',
        confidence: null
      };
    }

    const embeddings = Array.from(detection.descriptor);
    const confidence = detection.detection.score;

    console.log(`[AI] Face detected with ${(confidence * 100).toFixed(1)}% confidence`);
    console.log(`[AI] Generated embedding length: ${embeddings.length}`);

    return {
      success: true,
      embeddings: embeddings,
      error: null,
      confidence: confidence
    };

  } catch (error) {
    console.error('[ERROR] Embedding extraction failed:', error.message);
    return {
      success: false,
      embeddings: null,
      error: `Processing error: ${error.message}`,
      confidence: null
    };
  } finally {
    if (tensorData && tensorData.tensor) {
      tensorData.tensor.dispose();
    }
  }
}

module.exports = {
  loadModels,
  extractEmbeddings
};
