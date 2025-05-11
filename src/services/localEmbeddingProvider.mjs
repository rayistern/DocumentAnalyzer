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
  strictMode = false,
  task
}) {
  try {
    logger.info(`strictMode value: ${strictMode}`);
    const modelKey = model;
    let actualModel = model; // Track which model was actually used
    
    logger.info(`🔍 Attempting to use model: ${model} with task: ${task || 'feature-extraction'}`);
    
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
        // Use the user-specified task, or default to 'feature-extraction'
        const pipelineTask = task || 'feature-extraction';
        logger.info(`Using task type: ${pipelineTask}`);
        
        // Attempt to load the model
        logger.info('Initializing model pipeline...');
        const embedder = await pipeline(pipelineTask, model, {
          quantized: true
        });
        
        logger.info('✅ Model loaded successfully!');
        modelCache.set(modelKey, { embedder, actualModel });
      } catch (modelError) {
        logger.error(`❌ Failed to load model ${model}:`, modelError);
        
        // If strict mode, don't fall back and fail instead
        if (strictMode) {
          // Include stack and error type for easier debugging
          throw new Error(
            `Model '${model}' failed to load in strict mode: ${modelError && modelError.stack ? modelError.stack : modelError.message || modelError}`
          );
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
    
    // Always use the same embedding call, let the user pick the right pipeline
    const result = await embedder(text, {
      pooling: 'mean',
      normalize: true,
    });
    const embedding = Array.from(result.data);
    
    logger.info(`✅ Generated embedding with dimension: ${embedding.length} using model: ${actualModel}`);
    
    // Return both embedding and actual model used
    return { embedding, actualModel };
  } catch (error) {
    logger.error(`❌ Local embedding error:`, error);
    throw new Error(`Local embedding failed: ${error.message}`);
  }
} 