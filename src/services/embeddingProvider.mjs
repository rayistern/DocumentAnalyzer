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
}) {
  // Empty string check
  if (!text || typeof text !== 'string' || text.trim() === '') {
    throw new Error('Text to embed cannot be empty');
  }
  
  // Trim/cleanup text
  const cleanText = text.trim().replace(/\s+/g, ' ');
  
  // Handle local models (prefixed with "local:")
  if (provider === 'local' || model?.startsWith('local:')) {
    const localModel = model?.startsWith('local:') 
      ? model.substring(6) // Remove 'local:' prefix
      : 'Xenova/all-MiniLM-L6-v2'; // Default local model
    
    // Check if this is a Hebrew-specific model
    const isHebrewModel = localModel.includes('BEREL') || 
                          localModel.includes('dicta-il') ||
                          localModel.toLowerCase().includes('hebrew');
    
    return localEmbed({ 
      text: cleanText, 
      model: localModel,
      useHebrewModel: isHebrewModel
    });
  }
  
  const fn = providers[provider];
  if (!fn) throw new Error(`Unknown provider ${provider}`);
  return fn(cleanText, model);
}

export const registerProvider = (name, fn) => (providers[name] = fn); 