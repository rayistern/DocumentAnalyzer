# Database Schema

## Overview

The Document Analyzer uses Supabase (PostgreSQL) for persistent storage of documents, chunks, and metadata. This document explains the database schema and how document processing interacts with it.

## Core Tables

### document_sources

Stores original source information about documents:

| Column | Description |
|--------|-------------|
| id | Primary key |
| filename | Original filename (required) |
| original_content | Raw document content |
| cleaned_content | Content after cleaning (optional) |
| status | Processing status (e.g., 'pending', 'processed', 'skipped') |
| group_number | Optional grouping parameter for batch processing |
| created_at | Creation timestamp |
| updated_at | Last update timestamp |

### documents

Stores processed documents and their metadata:

| Column | Description |
|--------|-------------|
| id | Primary key |
| content | Document content |
| type | Processing type (e.g., 'cleanAndChunk', 'fullMetadata_only') |
| warnings | Array of processing warnings |
| original_filename | Original filename (required) |
| document_source_id | Foreign key to document_sources |
| content_hash | Hash of content for deduplication |
| status | Processing status |
| duplicate_of | Reference to duplicate document (if skipped) |
| raw_llm_response | Raw LLM response for metadata operations |
| created_at | Creation timestamp |
| updated_at | Last update timestamp |

### chunks

Stores individual semantic chunks:

| Column | Description |
|--------|-------------|
| id | Primary key |
| document_id | Foreign key to documents |
| document_source_id | Foreign key to document_sources |
| start_index | Start position in original text |
| end_index | End position in original text |
| cleaned_text | Cleaned chunk text |
| original_text | Original chunk text before cleaning |
| warnings | Array of chunk-specific warnings |
| created_at | Creation timestamp |
| updated_at | Last update timestamp |

### prechunks

Stores pre-chunking information:

| Column | Description |
|--------|-------------|
| id | Primary key |
| document_id | Foreign key to documents |
| chunk_index | Processing order index |
| text | Pre-chunk text |
| start_position | Start position in document |
| end_position | End position in document |
| is_complete | Whether this is a complete chunk |
| remainder_text | Remainder text at this point (for debugging) |
| remainder_length | Length of remainder text |
| created_at | Creation timestamp |

## Database Interactions

### Document Creation

1. **Initial Save**:
   ```javascript
   // Create document_sources record
   const sourceData = await supabase
       .from('document_sources')
       .insert({
           filename: metadata.filepath,
           original_content: content,
           status: 'cleanAndChunk',
           group_number: metadata.groupNumber
       })
       .select()
       .single();

   // Create documents record
   const docData = await supabase
       .from('documents')
       .insert({
           content: content,
           type: 'cleanAndChunk',
           original_filename: metadata.filepath,
           document_source_id: sourceData.id,
           // ...other fields
       })
       .select()
       .single();
   ```

### Chunk Saving

```javascript
// Insert chunks
const chunksToInsert = chunks.map(chunk => ({
    document_id: document.id,
    document_source_id: documentSourceId,
    start_index: chunk.startIndex,
    end_index: chunk.endIndex,
    cleaned_text: chunk.cleanedText,
    original_text: chunk.originalText,
    // ...other fields
}));

await supabase.from('chunks').insert(chunksToInsert);
```

### Status Updates

```javascript
// Update document status when processing is complete
await supabase
    .from('documents')
    .update({
        status: 'processed',
        updated_at: new Date().toISOString()
    })
    .eq('id', document.id);
```

## Recent Changes and Fixes

### 1. Removed document_remainders Table

Previously, remainder text was stored in a dedicated table. Now:
- Remainder text is kept in memory during batch processing
- Final remainder text is stored in `raw_llm_response` for reference

### 2. Fixed Schema Constraints

- Added handling for required fields:
  - `original_filename` in documents
  - `filename` in document_sources
  - Properly forwarding filepath parameters

### 3. Group Number Handling

- Group number is now correctly stored only in document_sources table
- Added proper parameter passing from CLI to database

## Best Practices

1. **Always Pass Filepath**: Ensure filepath is correctly passed when creating documents
2. **Group Related Documents**: Use the group parameter to organize related documents
3. **Check Document Status**: Monitor document status field for processing state

## Command Example

```
node src/index.mjs batch "path/to/files/*.docx" -t cleanAndChunk --continuation -g myGroup
```

This command processes all matching files, organizing them under the group "myGroup" in the database. 