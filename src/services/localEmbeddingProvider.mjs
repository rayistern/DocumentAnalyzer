import { pipeline, env } from '@xenova/transformers';
import logger from '../utils/logger.mjs';

// Set model download directory if needed
// env.cacheDir = './models';

// Cache for loaded models
const modelCache = new Map();

/**
 * Generate embeddings using local models via Transformers.js
 */
export async function localEmbed({ 
  text, 
  model = 'Xenova/all-MiniLM-L6-v2', 
  batchSize = 1,
  useHebrewModel = false
}) {
  try {
    // Special handling for BEREL/Hebrew models
    const modelKey = model;
    
    // Get or initialize the model
    if (!modelCache.has(modelKey)) {
      logger.info(`🔄 Loading local embedding model: ${model}`);
      
      // For BEREL we need to use sentence-transformers pipeline specifically
      const task = useHebrewModel ? 'sentence-transformers' : 'feature-extraction';
      
      // Load the model - for BEREL we might need different options
      const embedder = await pipeline(task, model, {
        quantized: !useHebrewModel, // Don't quantize specialized models
        revision: useHebrewModel ? 'main' : null
      });
      
      modelCache.set(modelKey, embedder);
    }
    
    const embedder = modelCache.get(modelKey);
    
    // Generate embeddings
    logger.info(`⚙️ Generating embeddings with local model: ${model}`);
    
    // Different handling based on model type
    let embedding;
    if (useHebrewModel) {
      // For BEREL or other sentence-transformers
      const result = await embedder(text);
      embedding = Array.from(result.data);
    } else {
      // Standard feature extraction
      const result = await embedder(text, {
        pooling: 'mean',
        normalize: true,
      });
      embedding = Array.from(result.data);
    }
    
    logger.info(`✅ Generated embedding with dimension: ${embedding.length}`);
    
    return embedding;
  } catch (error) {
    logger.error(`❌ Local embedding error:`, error);
    throw new Error(`Local embedding failed: ${error.message}`);
  }
} 