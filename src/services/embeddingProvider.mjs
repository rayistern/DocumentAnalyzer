import settings from '../config/settings.mjs';
import { getOpenAIEmbedding } from './openaiService.mjs';
import { getHFEmbedding } from './hfService.mjs';

const providers = {
  openai: getOpenAIEmbedding,
  hf: getHFEmbedding,
};

export async function embed({
  text,
  provider = settings.embedding.provider,
  model = settings.embedding.model,
}) {
  const fn = providers[provider];
  if (!fn) throw new Error(`Unknown provider ${provider}`);
  return fn(text, model);
}

export const registerProvider = (name, fn) => (providers[name] = fn); 