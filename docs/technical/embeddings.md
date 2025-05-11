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