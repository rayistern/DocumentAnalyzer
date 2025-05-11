import fetch from 'node-fetch';
import { registerProvider } from '../services/embeddingProvider.mjs';

const PY_EMBED_URL = process.env.PY_EMBED_URL || 'http://localhost:8001/embed';

async function getPythonEmbedding(text, model) {
  const res = await fetch(PY_EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model }),
  });

  if (!res.ok) {
    throw new Error(`Python provider error: ${await res.text()}`);
  }

  const { embedding, model: actualModel } = await res.json();
  return { embedding, actualModel: actualModel || model };
}

registerProvider('python', getPythonEmbedding); 