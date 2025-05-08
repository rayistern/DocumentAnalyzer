import fetch from 'node-fetch';

export async function getHFEmbedding(
  text,
  model = 'sentence-transformers/all-MiniLM-L6-v2',
) {
  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    },
  );
  if (!res.ok) throw new Error(`HF ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data[0];
} 