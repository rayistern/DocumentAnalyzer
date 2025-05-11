import { pipeline } from '@xenova/transformers';
import logger from '../utils/logger.mjs';

// Cache for loaded models
const modelCache = new Map();

/**
 * Generate embeddings using local models via Transformers.js
 */
export async function localEmbed({ text, model = 'Xenova/all-MiniLM-L6-v2', batchSize = 1 }) {
  try {
    // Get or initialize the model
    if (!modelCache.has(model)) {
      logger.info(`🔄 Loading local embedding model: ${model}`);
      const embedder = await pipeline('feature-extraction', model, {
        quantized: true, // Use quantized version for better performance
      });
      modelCache.set(model, embedder);
    }
    
    const embedder = modelCache.get(model);
    
    // Generate embeddings
    logger.info(`⚙️ Generating embeddings with local model: ${model}`);
    const result = await embedder(text, {
      pooling: 'mean',
      normalize: true,
    });
    
    // Convert to array of numbers for storage compatibility
    const embedding = Array.from(result.data);
    logger.info(`✅ Successfully generated embedding with dimension: ${embedding.length}`);
    
    return embedding;
  } catch (error) {
    logger.error(`❌ Local embedding error:`, error);
    throw new Error(`Local embedding failed: ${error.message}`);
  }
} 