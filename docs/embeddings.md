# Embeddings Guide

This document explains how to generate and use vector embeddings in the DocumentAnalyzer system.

## Overview

The system supports multiple embedding workflows:
1. **Direct embedding to Supabase**: Generate and immediately store in Supabase
2. **Local embedding files**: Generate and store locally as JSON files, then upload later
3. **Local GPU embedding**: Generate embeddings using local models via transformers.js

## Commands

### 1. Direct Embedding to Supabase

```bash
node src/index.mjs basic-embed --table <table> --column <column> [options]
```

**Options:**
- `--table` - Source table (required)
- `--column` - Source column to embed (required)
- `--id` - Filter by exact ID
- `--lt` - Filter for IDs less than value
- `--gt` - Filter for IDs greater than value
- `--batch` - Batch size (default: 5)
- `--model` - Embedding model (default from settings)
- `--group` - Embedding group name (default: 'default')

**Example:**
```bash
node src/index.mjs basic-embed --table chunk_metadata --column long_summary --lt 100 --model text-embedding-ada-002
```

### 2. Local Embedding Files

```bash
node src/index.mjs local-embed --table <table> --column <column> [options]
```

**Options:**
- Same as basic-embed, plus:
- `--output-dir` - Directory to save embedding files (default: ./embeddings)
- `--provider` - Embedding provider (default: 'openai')
- `--strict` - Fail if specified model is unavailable (default: false)

**Example:**
```bash
node src/index.mjs local-embed --table chunk_metadata --column long_summary --lt 50 --output-dir ./my-embeddings
```

### 3. Upload Local Embeddings to Supabase

```bash
node src/index.mjs upload-embeddings [options]
```

**Options:**
- `--dir` - Directory with embedding files (default: ./embeddings)
- `--batch-size` - Upload batch size (default: 20)

**Example:**
```bash
node src/index.mjs upload-embeddings --dir ./my-embeddings --batch-size 10
```

## Local GPU Embeddings

You can generate embeddings using your local GPU via the transformers.js library.

### Prerequisites

Install the required package:
```bash
npm install @xenova/transformers
```

### Usage

```bash
node src/index.mjs local-embed --table chunk_metadata --column long_summary --provider local --model "Xenova/all-MiniLM-L6-v2" --group local-minilm
```

### Supported Models

The system works with models from the Hugging Face model hub:

1. **General purpose models**:
   - `Xenova/all-MiniLM-L6-v2` - Fast, 384 dimensions (~150MB)
   - `Xenova/bge-small-en-v1.5` - Better quality, 384 dimensions (~250MB)
   - `Xenova/e5-small-v2` - Good balance, 384 dimensions (~200MB)

2. **Language-specific models**:
   - `Xenova/hebrew-bert` - Hebrew language model
   - `avichr/heBERT` - Alternative Hebrew model
   - Many other language models from Hugging Face

### Model Fallback Behavior

By default, if a requested model cannot be loaded, the system will fall back to `Xenova/all-MiniLM-L6-v2`. The actual model used will be included in the output filename.

To prevent fallback and fail immediately when a model is unavailable:

```bash
node src/index.mjs local-embed --table chunk_metadata --column long_summary --provider local --model "allenai/hebrew-bert" --strict
```

### Performance Considerations

1. **First run** will download the model (~100-300MB depending on model)
2. **Memory usage** is moderate (~1-2GB RAM)
3. **Speed** depends on your GPU but generally much faster than API calls
4. **Dimensions** will be different (usually 384 or 768) than OpenAI (1536)

## Workflow Examples

### Standard Workflow

Generate embeddings for all content and store directly in Supabase:

```bash
node src/index.mjs basic-embed --table chunk_metadata --column long_summary
```

### Phased Workflow (Recommended)

1. Generate and store locally (avoids database connectivity issues):
   ```bash
   node src/index.mjs local-embed --table chunk_metadata --column long_summary
   ```

2. Later, upload to Supabase when ready:
   ```bash
   node src/index.mjs upload-embeddings
   ```

### Using Multiple Embedding Models (Groups)

You can maintain multiple embedding models for the same data by using different group names:

```bash
# Generate OpenAI Ada embeddings
node src/index.mjs local-embed --table chunk_metadata --column long_summary --model text-embedding-ada-002 --group openai-ada

# Generate local model embeddings
node src/index.mjs local-embed --table chunk_metadata --column long_summary --provider local --model Xenova/all-MiniLM-L6-v2 --group local-minilm

# Upload all embeddings
node src/index.mjs upload-embeddings
```

This approach allows:
- Parallel searches with different models
- A/B testing between embedding models
- Gradual migration to newer models
- Using specialized models for different query types

### Processing Multiple Columns

Process different text columns:

```bash
# Process long_summary
node src/index.mjs local-embed --table chunk_metadata --column long_summary

# Process short_summary
node src/index.mjs local-embed --table chunk_metadata --column short_summary

# Upload all at once
node src/index.mjs upload-embeddings
```

## Storage Format

### Supabase Table

Embeddings are stored in the `embeddings` table with this schema:
- `source_table` - Source table name
- `source_pk` - Primary key in source table
- `source_column` - Column that was embedded
- `group` - Embedding group name (allows multiple embedding models per content)
- `model` - Embedding model used
- `dim` - Vector dimensions
- `embedding` - The vector data

The unique constraint ensures you can have multiple embeddings for the same content, as long as they're in different groups or use different models.

### Local JSON Files

Local embedding files use the naming convention:
```
{table}_{id}_{column}_{group}_{actual_model}.json
```

Where `actual_model` is the model actually used (may be different from requested model if fallback occurred).

Example file contents:
```json
{
  "source_table": "chunk_metadata",
  "source_pk": 42,
  "source_column": "long_summary",
  "group": "openai-ada",
  "model": "text-embedding-ada-002",
  "provider": "openai",
  "dim": 1536,
  "embedding": [0.0023, -0.0118, ...],
  "created_at": "2024-05-08T22:45:12.123Z"
}
```

## Skip Behavior

Both local and database embedding commands will check for existing embeddings and skip rows that already have embeddings for the specified group and model. This allows you to:

- Resume interrupted embedding jobs
- Update only specific rows while skipping existing ones
- Add new embedding models without reprocessing everything

## Troubleshooting

If you encounter errors with the embedding process:

1. Check your OpenAI API key is valid and has sufficient quota
2. Verify the Supabase connection is working
3. Try using the local embedding approach first to isolate API issues
4. For PowerShell users, use single quotes for JSON parameters:
   ```
   --filter '{"id":"lt.100"}'
   ```
5. For local model errors, try installing the transformers package:
   ```
   npm install @xenova/transformers
   ```
6. Use --strict flag to see detailed error messages when a model fails to load
7. When all else fails, specific model errors appear in the log

# Embeddings: Local Model Usage

## Overview

You can generate embeddings using local models via [transformers.js](https://xenova.github.io/transformers.js/).  
**You must now explicitly specify both the model and the pipeline/task.**  
There is no longer any automatic detection of language or model type.

---

## Usage

### Example: Feature Extraction (default for most models)

```bash
node src/index.mjs local-embed \
  --table chunk_metadata \
  --column long_summary \
  --provider local \
  --model "Xenova/bert-base-multilingual-cased" \
  --task feature-extraction \
  --strict
```

### Example: Sentence Transformers

```bash
node src/index.mjs local-embed \
  --table chunk_metadata \
  --column long_summary \
  --provider local \
  --model "Xenova/all-MiniLM-L6-v2" \
  --task sentence-transformers \
  --strict
```

---

## Parameters

- `--model`  
  The Hugging Face model to use (must be compatible with [transformers.js](https://xenova.github.io/transformers.js/model_support/)).

- `--task`  
  The pipeline/task to use for the model.  
  Common values:
  - `feature-extraction` (default)
  - `sentence-transformers`
  - See [transformers.js pipelines](https://xenova.github.io/transformers.js/pipelines/) for more.

- `--strict`  
  If set, the process will fail if the model cannot be loaded (no fallback).

---

## Notes

- You **must** specify the correct `--task` for your model.
- There is **no longer any automatic selection** of pipeline/task based on the model name or language.
- If `--strict` is set and the model cannot be loaded, the process will stop with an error.
- If `--strict` is not set, the script will attempt to use a fallback model.

## Uploading Local Embeddings to Supabase

You can upload all local embedding files to Supabase using:

```powershell
node .\src\index.mjs upload-embeddings --dir '.\embeddings' --batch-size 100
```

### Filtering by Group

To upload only embeddings for a specific group, use the `--group` flag:

```powershell
node .\src\index.mjs upload-embeddings --dir '.\embeddings' --group mygroup
```

This will only upload files whose filenames include the specified group.

### Deduplication and Upsert Behavior

- The upload process uses an **upsert** operation with the following conflict criteria:
  - `source_table`
  - `source_pk`
  - `source_column`
  - `group`
  - `model`
- If a row with the same values for all these fields already exists, the upsert will **update/replace** the existing row with the new data.
- If any of these fields differ, a **new row** will be inserted.
- This allows you to store multiple embeddings for the same record, as long as they differ by group, model, or column.

### Example: Multiple Embeddings for the Same Record

| source_table   | source_pk | source_column | group      | model                    | Result         |
|----------------|-----------|--------------|------------|--------------------------|---------------|
| chunk_metadata | 123       | long_summary | default    | Xenova/all-MiniLM-L6-v2  | Upsert/replace|
| chunk_metadata | 123       | long_summary | default    | text-embedding-ada-002   | New row       |
| chunk_metadata | 123       | long_summary | mygroup    | Xenova/all-MiniLM-L6-v2  | New row       |

### Safety

- You can safely re-run the upload command; only new or changed embeddings will be inserted or updated.
- No duplicate rows will be created for the same (source_table, source_pk, source_column, group, model) combination. 