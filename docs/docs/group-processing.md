# Document Group Processing

## Overview
The document analyzer supports processing documents in groups, allowing you to organize and process sets of related documents together. This feature enables you to:
- Process the same document multiple times in different groups
- Check for duplicates only within the same group
- Track and manage document sets separately

## Usage

### Command Line Interface
Use the `-g` or `--group` flag with a descriptive name when running batch processing:

```bash
# Process files in the "likkuteiTorah" group
node src/index.mjs batch "path/to/files/*.txt" -g likkuteiTorah

# Process same files in test group
node src/index.mjs batch "path/to/files/*.txt" -g test_version

# Process without group (checks against all documents)
node src/index.mjs batch "path/to/files/*.txt"
```

### Behavior

#### Document Skipping
- With group specified: Documents are only skipped if they exist in the same group
- Without group: Documents are skipped if they exist in any group

#### Deduplication
- With group specified: Documents are only considered duplicates if they have identical content AND are in the same group
- Without group: Documents are considered duplicates if they have identical content in any group

## Database Schema
The group name is stored as text in the `document_sources` table:
```sql
ALTER TABLE document_sources ADD COLUMN group_number text;
```

## Use Cases

1. **Multiple Processing Configurations**
   - Process the same documents with different chunk sizes (e.g., group "chunks_2000" vs "chunks_5000")
   - Apply different metadata extraction rules (e.g., "basic_metadata" vs "full_metadata")
   - Test different processing parameters (e.g., "test_config_1" vs "test_config_2")

2. **Document Set Organization**
   - Group documents by topic (e.g., "likkuteiTorah", "tanyaFirst", etc.)
   - Group documents by source (e.g., "kehot_scans", "chabad_org")
   - Group documents by processing date (e.g., "march2024_batch")

3. **Parallel Processing**
   - Process different versions of documents (e.g., "v1", "v2")
   - Compare processing results across groups
   - Maintain separate document sets for different purposes 