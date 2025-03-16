# Model Tracking in Document Analyzer

## Overview
A new feature has been added to track which LLM model was used during the metadata generation step. This information is stored in the `model_used` column of the `chunk_metadata` table.

## Implementation Details

### Database Changes
- Added a new `model_used` TEXT column to the `chunk_metadata` table

### Code Changes
- Updated the `saveChunkMetadata` function in `src/services/supabaseService.mjs` to accept and store the model information
- Modified the metadata processing code in `src/services/openaiService.mjs` to pass the model information from the API response

## How to Use
The model information is automatically captured from the OpenAI API response and stored in the database. You can query this information to:

- Track which model was used for each chunk's metadata generation
- Analyze performance or quality differences between different models
- Debug issues related to specific models

## Migration
A migration script has been created at `DocumentAnalyzer/migrations/add_model_used_column.sql` to add the new column to the database.

To run the migration:
```sql
-- Run this script to add the model_used column to the chunk_metadata table
psql -U <your_username> -d <your_database> -f DocumentAnalyzer/migrations/add_model_used_column.sql
```

Or manually execute:
```sql
ALTER TABLE chunk_metadata ADD COLUMN IF NOT EXISTS model_used TEXT;
COMMENT ON COLUMN chunk_metadata.model_used IS 'The LLM model used to generate this metadata';
```

## Example Query
To see which models have been used for metadata generation:

```sql
SELECT DISTINCT model_used, COUNT(*) as count
FROM chunk_metadata
GROUP BY model_used
ORDER BY count DESC;
``` 