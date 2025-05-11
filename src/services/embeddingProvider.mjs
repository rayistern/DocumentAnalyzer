import settings from '../config/settings.mjs';
import { getOpenAIEmbedding } from './openaiService.mjs';
import { getHFEmbedding } from './hfService.mjs';
import { localEmbed } from './localEmbeddingProvider.mjs';

const providers = {
  openai: getOpenAIEmbedding,
  hf: getHFEmbedding,
};

export async function embed({
  text,
  provider = settings.embedding.provider,
  model = settings.embedding.model,
  options,
}) {
  // Empty string check
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Text to embed cannot be empty');
  }
  
  // Trim/cleanup text
  const cleanText = text.trim().replace(/\s+/g, ' ');
  
  // Handle local models (prefixed with "local:")
  if (provider === 'local' || model?.startsWith('local:')) {
    // If model has local: prefix, remove it, otherwise use the provided model
    // Only fall back to default if model is null/undefined
    const localModel = model?.startsWith('local:') 
      ? model.substring(6) // Remove 'local:' prefix
      : (model || 'Xenova/all-MiniLM-L6-v2'); // Use specified model or default
    
    // Check if this is a Hebrew-specific model
    const isHebrewModel = localModel.includes('BEREL') || 
                          localModel.includes('dicta-il') ||
                          localModel.toLowerCase().includes('hebrew');
    
    const result = await localEmbed({ 
      text: cleanText, 
      model: localModel,
      useHebrewModel: isHebrewModel,
      strictMode: options?.strictMode || false
    });
    
    return result; // Return object with embedding and actualModel
  }
  
  let fn = providers[provider];
  // auto-load provider module if missing
  if (!fn) {
    try {
      await import(`../providers/${provider}Provider.mjs`);
      fn = providers[provider];
    } catch { /* ignore */ }
  }
  if (!fn) throw new Error(`Unknown provider ${provider}`);
  return fn(cleanText, model);
}

export const registerProvider = (name, fn) => (providers[name] = fn); 