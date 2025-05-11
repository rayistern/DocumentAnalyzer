import { pipeline, env } from '@xenova/transformers';
import logger from '../utils/logger.mjs';

// Set model download directory if needed
// env.cacheDir = './models';

// Enable debug logging for transformers.js
env.debug = true;

// Cache for loaded models
const modelCache = new Map();

/**
 * Generate embeddings using local models via Transformers.js
 */
export async function localEmbed({ 
  text, 
  model = 'Xenova/all-MiniLM-L6-v2', 
  batchSize = 1,
  useHebrewModel = false,
  strictMode = false
}) {
  try {
    // Special handling for BEREL/Hebrew models
    const modelKey = model;
    let actualModel = model; // Track which model was actually used
    
    logger.info(`🔍 Attempting to use model: ${model} (Hebrew-specific: ${useHebrewModel})`);
    
    // Check if @xenova/transformers is installed correctly
    try {
      logger.info('Verifying transformers.js is working...');
      const version = env.version || 'unknown';
      logger.info(`Using transformers.js version: ${version}`);
    } catch (err) {
      logger.error('❌ Problem with transformers.js:', err);
      throw new Error('transformers.js package not correctly installed. Run: npm install @xenova/transformers');
    }
    
    // Get or initialize the model
    if (!modelCache.has(modelKey)) {
      logger.info(`🔄 Loading local embedding model: ${model}`);
      
      try {
        // For BEREL we need to use sentence-transformers pipeline specifically
        const task = useHebrewModel ? 'sentence-transformers' : 'feature-extraction';
        logger.info(`Using task type: ${task}`);
        
        // Attempt to load the model
        logger.info('Initializing model pipeline...');
        const embedder = await pipeline(task, model, {
          quantized: !useHebrewModel, // Don't quantize specialized models
          revision: useHebrewModel ? 'main' : null
        });
        
        logger.info('✅ Model loaded successfully!');
        modelCache.set(modelKey, { embedder, actualModel });
      } catch (modelError) {
        logger.error(`❌ Failed to load model ${model}:`, modelError);
        
        // If strict mode, don't fall back and fail instead
        if (strictMode) {
          throw new Error(`Model '${model}' failed to load in strict mode: ${modelError.message}`);
        }
        
        // Fallback to a known working model
        const fallbackModel = 'Xenova/all-MiniLM-L6-v2';
        actualModel = fallbackModel;
        logger.info(`⚠️ Falling back to default model: ${fallbackModel}`);
        
        const fallbackEmbedder = await pipeline('feature-extraction', fallbackModel, {
          quantized: true
        });
        
        modelCache.set(modelKey, { embedder: fallbackEmbedder, actualModel: fallbackModel });
      }
    } else {
      const cached = modelCache.get(modelKey);
      actualModel = cached.actualModel;
    }
    
    const { embedder } = modelCache.get(modelKey);
    
    // Generate embeddings
    logger.info(`⚙️ Generating embeddings with actual model: ${actualModel}`);
    
    // Different handling based on model type
    let embedding;
    if (useHebrewModel && actualModel === model) { // Only use Hebrew path if we didn't fall back
      logger.info('Using Hebrew-specific embedding path');
      const result = await embedder(text);
      embedding = Array.from(result.data);
    } else {
      logger.info('Using standard embedding path');
      const result = await embedder(text, {
        pooling: 'mean',
        normalize: true,
      });
      embedding = Array.from(result.data);
    }
    
    logger.info(`✅ Generated embedding with dimension: ${embedding.length} using model: ${actualModel}`);
    
    // Return both embedding and actual model used
    return { embedding, actualModel };
  } catch (error) {
    logger.error(`❌ Local embedding error:`, error);
    throw new Error(`Local embedding failed: ${error.message}`);
  }
} 