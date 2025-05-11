# Vector-embedding pipeline (v1)

## 1 Quick diagram
raw rows → `embedSupabase` batch → provider API (OpenAI / HF / …) → `embeddings` table (pgvector) → similarity queries / RAG

## 2 Environment
SUPABASE_URL= …  
SUPABASE_KEY= …  
OPENAI_API_KEY= …           # only if provider=openai  
HF_TOKEN= …                 # only if provider=hf  
EMBED_FIELDS=[{"table":"articles","column":"body"}]  
EMBED_PROVIDER=openai        # default  
EMBED_MODEL=text-embedding-ada-002  
…see `src/config/settings.mjs` for all knobs.

## 3 SQL
Run `migrations/01_create_embeddings.sql`.  
Important: `create extension pgvector;`

Schema cheat-sheet  
id | source_table | source_pk | source_column | model | dim | embedding (vector) | created_at

A composite unique index avoids duplicates per field/model.

## 4 CLI usage
Embed default config  

node src/index.mjs embed --provider openai --model text-embedding-ada-002

Flags: provider, model, batch, table, column, filter override config.

4. Add new provider with `registerProvider(name, fn)`.

Null / empty fields are skipped; all settings tweakable via `.env` or CLI. 

Embed a single column on the fly  
```
node src/index.mjs embed \
  --table documents --column content \
  --filter '{"status":"published"}' \
  --provider hf --model sentence-transformers/all-MiniLM-L6-v2
```

Tweak batch size & rate-limit  
```
EMBED_BATCH=20 EMBED_DELAY=500 node src/index.mjs embed
```

## 5 How to add a provider
```js
// myProvider.mjs
export async function myEmbed(text) { … }
import { registerProvider } from '../services/embeddingProvider.mjs';
registerProvider('my', myEmbed);
```
Then run with `--provider my`.

## 6 Null / empty handling
Rows with null/empty target column are skipped (see embedSupabase).

## 7 Multi-field strategy
We store one record per (row, column, model).  
If you need a "whole-row" vector, just add another entry with `source_column = '*'`.

## 8 Query example
```sql
-- top-5 nearest neighbours to :vec
select *, embedding <-> :vec as dist
from embeddings
where model = 'text-embedding-ada-002'
order by dist limit 5;
```

# Technical Details: Local Embedding Pipeline

## Explicit Model and Pipeline Selection

The embedding system now requires **explicit selection** of both the model and the pipeline/task when using local models.

- The user must provide both `--model` and `--task` on the command line.
- The code does **not** attempt to infer the correct pipeline/task based on the model name or language.
- The default pipeline is `feature-extraction` if `--task` is not specified.

## Example CLI Usage

```bash
node src/index.mjs local-embed \
  --table chunk_metadata \
  --column long_summary \
  --provider local \
  --model "Xenova/all-MiniLM-L6-v2" \
  --task sentence-transformers \
  --strict
```

## Supported Pipelines

Refer to the [transformers.js pipelines documentation](https://xenova.github.io/transformers.js/pipelines/) for a list of supported pipelines.

- `feature-extraction` (default)
- `sentence-transformers`
- ...and others as supported by your model

## Fallback and Strict Mode

- If `--strict` is set, the process will fail if the model cannot be loaded.
- If `--strict` is not set, the system will attempt to use a fallback model.

## Migration Note

- All previous heuristics for language or model-based pipeline selection have been removed.
- This change makes the system more predictable and transparent for advanced users.

--- 