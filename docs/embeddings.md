# Embeddings Guide

This document explains how to generate and use vector embeddings in the DocumentAnalyzer system.

## Overview

The system supports two embedding workflows:
1. **Direct embedding to Supabase**: Generate and immediately store in Supabase
2. **Local embedding files**: Generate and store locally as JSON files, then upload later

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

**Example:**
```bash
node src/index.mjs basic-embed --table chunk_metadata --column long_summary --lt 100
```

### 2. Local Embedding Files

```bash
node src/index.mjs local-embed --table <table> --column <column> [options]
```

**Options:**
- Same as basic-embed, plus:
- `--output-dir` - Directory to save embedding files (default: ./embeddings)

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
- `model` - Embedding model used
- `dim` - Vector dimensions
- `embedding` - The vector data

### Local JSON Files

Local embedding files use the naming convention:
```
{table}_{id}_{column}_{model}.json
```

Example file contents:
```json
{
  "source_table": "chunk_metadata",
  "source_pk": 42,
  "source_column": "long_summary",
  "model": "text-embedding-ada-002",
  "provider": "openai",
  "dim": 1536,
  "embedding": [0.0023, -0.0118, ...],
  "created_at": "2024-05-08T22:45:12.123Z"
}
```

## Troubleshooting

If you encounter errors with the embedding process:

1. Check your OpenAI API key is valid and has sufficient quota
2. Verify the Supabase connection is working
3. Try using the local embedding approach first to isolate API issues
4. For PowerShell users, use single quotes for JSON parameters:
   ```
   --filter '{"id":"lt.100"}'
   ```
5. When all else fails, specific model errors appear in the log 