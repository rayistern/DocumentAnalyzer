# Model Tracking and Response Logging in Document Analyzer

## Overview
Two new features have been added to improve metadata tracking and debugging:
1. The `model_used` column tracks which LLM model was used during metadata generation
2. The `raw_llm_response` column stores the complete unmodified LLM response for debugging parsing failures

## Implementation Details

### Database Changes
- Added a new `model_used` TEXT column to the `chunk_metadata` table
- Added a new `raw_llm_response` TEXT column to store the raw LLM response

### Code Changes
- Updated the `saveChunkMetadata` function to accept and store model information and raw responses
- Modified the metadata processing code to pass the model information and raw response

## How to Use
The system now automatically captures:
- The LLM model name from the API response
- The complete raw LLM response for debugging

### Benefits
- Track which model generated which metadata
- Debug JSON parsing failures by examining the raw responses
- Analyze model performance differences
- Identify problematic responses that cause parsing errors

## Migration
Two migration scripts have been created:
1. `DocumentAnalyzer/migrations/add_model_used_column.sql` - Adds the model tracking column
2. `DocumentAnalyzer/migrations/add_raw_llm_response_column.sql` - Adds the raw response storage column

To run the migrations:
```sql
-- Run these scripts to add the new columns to the chunk_metadata table
psql -U <your_username> -d <your_database> -f DocumentAnalyzer/migrations/add_model_used_column.sql
psql -U <your_username> -d <your_database> -f DocumentAnalyzer/migrations/add_raw_llm_response_column.sql
```

Or manually execute:
```sql
ALTER TABLE chunk_metadata ADD COLUMN IF NOT EXISTS model_used TEXT;
COMMENT ON COLUMN chunk_metadata.model_used IS 'The LLM model used to generate this metadata';

ALTER TABLE chunk_metadata ADD COLUMN IF NOT EXISTS raw_llm_response TEXT;
COMMENT ON COLUMN chunk_metadata.raw_llm_response IS 'The raw LLM response text, stored for debugging parsing failures';
```

## Example Queries

### Find models used for metadata generation:
```sql
SELECT DISTINCT model_used, COUNT(*) as count
FROM chunk_metadata
GROUP BY model_used
ORDER BY count DESC;
```

### Find chunks with parsing errors:
```sql
SELECT document_id, chunk_index, model_used, long_summary, raw_llm_response
FROM chunk_metadata
WHERE long_summary LIKE 'Failed to parse%' OR long_summary LIKE 'Error:%'
ORDER BY created_at DESC;
```

### Examine raw responses by model:
```sql
SELECT document_id, chunk_index, model_used, substring(raw_llm_response, 1, 200) as response_preview
FROM chunk_metadata
WHERE model_used = 'gpt-4.5-preview'
ORDER BY created_at DESC
LIMIT 10;
``` 