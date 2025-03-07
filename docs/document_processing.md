# Document Analyzer Processing Flow

## Overview

The Document Analyzer processes large documents by splitting them into semantic chunks that preserve meaning while being small enough for efficient processing. This document explains the core processing flow, especially how documents are broken into chunks and how text spans across chunk boundaries.

## Key Concepts

### Pre-chunks
- **Definition**: Initial, fixed-size divisions of the document used as a starting point
- **Purpose**: Break large documents into manageable pieces for initial processing
- **Size**: Controlled by `OPENAI_SETTINGS.preChunkSize` (typically 1500-4000 characters)

### Semantic Chunks
- **Definition**: Meaningful divisions of the text created by the LLM
- **Purpose**: Ensure text is broken at logical boundaries rather than arbitrary positions
- **Size**: Controlled by `maxChunkLength` parameter

### Remainder Text
- **Definition**: Text at the end of a pre-chunk that couldn't be included in a semantic chunk
- **Purpose**: Carried forward to the next pre-chunk to maintain context continuity
- **Flow**: End of one pre-chunk → Beginning of next pre-chunk
- **Important**: Remainder text is already cleaned and should not be cleaned again

## Processing Flow

1. **Document Loading**
   - Read document content from file
   - Generate content hash for tracking

2. **Pre-chunking**
   - Divide document into fixed-size "pre-chunks"
   - These serve as initial processing units

3. **Pre-chunk Processing (for each pre-chunk)**
   - **Cleaning the Pre-chunk**:
     - Send raw pre-chunk text to LLM for cleaning (without remainder)
     - LLM identifies text segments to remove (headers, footers, footnotes, etc.)
     - Apply removal to get cleaned pre-chunk text
     - **Important**: Cleaning is done ONLY on the raw pre-chunk, not on remainder text

   - **Combining with Remainder**:
     - Take the already-cleaned remainder text from the previous iteration
     - Prepend it to the cleaned current pre-chunk
     - This happens AFTER cleaning, as remainder text is already cleaned
     - Result: `finalCleanedText = remainder + cleanedPreChunk`

   - **Previous Document Context (optional)**:
     - If this is the first pre-chunk and we have previous document context
     - Prepend previous document text to the combined text
     - Only applies to the first chunk in continuation mode

   - **Semantic Chunking**:
     - Send the combined (and fully cleaned) text to LLM for semantic chunking
     - LLM divides text into logical chunks with start/end positions
     - Adjust chunk boundaries to find exact word matches

   - **Remainder Calculation**:
     - Text after the last semantic chunk becomes the remainder for next iteration
     - This remainder is already cleaned and won't be cleaned again
     - It will be prepended to the next pre-chunk's cleaned text

4. **Final Processing**
   - Process any remaining text as a final chunk
   - Validate all chunks for coverage and consistency
   - Save chunks to database

## Chunk Boundary Detection

A critical aspect of document processing is accurately detecting chunk boundaries. This system employs sophisticated position detection to ensure chunk boundaries occur at word breaks rather than arbitrary character positions.

### Position Calculation Flow

1. **Text Preparation**
   - Remainder text is prepended to the cleaned pre-chunk text
   - LLM receives the combined text (`finalCleanedText`) for chunking
   - LLM returns chunk positions that already include remainder offset (since it's part of the input)

2. **Position Adjustment Mechanisms**

   - **Cumulative Offset**: Tracks position drift between the LLM's calculation and actual text positions
     - Reset for each new pre-chunk (each LLM call)
     - Applied to all chunks within the same pre-chunk
     - Compensates for Unicode handling differences and other position drift

   - **Word Boundary Detection**: Uses `findWordPosition` to locate exact word matches
     - Uses multi-word phrases (3-4 words) at chunk boundaries for more reliable detection
     - Performs text normalization to handle diacritics and punctuation
     - Follows a systematic search approach:
       1. Exact match within standard tolerance range
       2. Normalized match within standard tolerance range
       3. Multi-word phrase matching for better context
       4. Fuzzy matching using Levenshtein distance within standard tolerance
       5. Expanded search to wider tolerance range
       6. Fallback to safe positions when no matches found
     - Ensures chunk boundaries are at word breaks, not mid-word

   - **Position Safety**: Ensures positions are valid and consistent
     - Prevents overlap with previous chunks
     - Handles out-of-bounds positions
     - Maintains minimum chunk sizes

3. **Remainder Calculation**
   - Uses the adjusted end position of the last chunk to determine where remainder text begins
   - Remainder = everything after the last chunk's end 
   - Ensures remainder starts at a proper word boundary

### Example Position Flow

```
Initial Text: "This is some text with remainder prepended."
LLM Says: "Chunk from position 6-15"
Cumulative Offset: +2 (from previous chunks)
Adjusted Position: 8-17
Boundary Detection: Finds "some text" at position 9-18
Final Chunk: position 9-18 with text "some text"
```

### Multi-word Phrase Advantages

Using multi-word phrases (3-4 words) for boundary detection offers several key advantages:

1. **Greater Uniqueness**: Phrases are much more likely to be unique within the text than single words
2. **Better Context**: More words provide additional context for accurate matching
3. **Robustness to Errors**: Multi-word matches are more tolerant of minor discrepancies
4. **Improved Non-Latin Script Handling**: Better for languages like Hebrew where single words may be ambiguous

### Fuzzy Matching System

When exact matches cannot be found, the system employs fuzzy matching with these characteristics:

1. **Text Normalization**: Pre-processes both search text and target by:
   - Removing diacritical marks
   - Standardizing punctuation
   - Normalizing whitespace

2. **Levenshtein Distance**: Calculates string similarity using edit distance algorithm
   - More sophisticated than simple character comparison
   - Works well for Unicode and non-Latin scripts
   - Adapts threshold based on word length (stricter for short words)

3. **Similarity Threshold**: Requires minimum 70% similarity for a match (80% for short words)
   - Prevents poor matches like "זיו" for "כי" that have little semantic similarity

### Search Order Progression

The position detection follows this precise order:

1. **Exact match** in normal tolerance range
2. **Normalized match** in normal tolerance range  
3. **Multi-word phrase matching** in normal tolerance range
4. **Fuzzy matching with Levenshtein** in normal tolerance range
5. Expand to wider tolerance and repeat steps 1-4
6. **Safe position fallback** if no matches found

This systematic approach ensures the most accurate position detection possible while gracefully handling edge cases.

## Remainder Text Handling

The system keeps remainder text completely in-memory:

1. Remainder text is NEVER stored in the database
2. It is passed between documents via in-memory variables
3. The `raw_llm_response` field is reserved for storing actual LLM responses from metadata operations
4. Each batch run will have its own in-memory remainder tracking across files

## Continuity Across Documents

When processing continues across multiple documents:

1. **Previous Document Context**: 
   - If `isContinuation` is true, system retrieves remainder from previous document
   - This remainder is prepended to the first pre-chunk's cleaned text

2. **Final Remainder**:
   - Last remainder from final document is kept in memory for potential continuation
   - Passed to the next document but never stored in the database

## Important Variables

- `remainderText`: Stores cleaned text that needs to be carried over to next pre-chunk
- `chunk.text`: Raw text of the current pre-chunk (before cleaning)
- `cleanedText`: Pre-chunk text after cleaning (but before combining with remainder)
- `finalCleanedText`: Fully prepared text sent to LLM for chunking (remainder + cleaned pre-chunk)

## Critical Workflow Order

1. Pre-chunk the document
2. For each pre-chunk:
   - Clean the raw pre-chunk (remove headers, footers, etc.)
   - Prepend already-cleaned remainder from previous iteration
   - Send combined text for semantic chunking
   - Extract new remainder from after the last chunk

## Common Issues

- **Double Cleaning**: If remainder text is included in cleaning, it gets cleaned twice
- **Missing Remainder**: Verify remainder is properly prepended after cleaning
- **Text Position Mismatch**: Ensure positions are calculated correctly for cleaned text

## Debugging Tips

When troubleshooting chunking issues:

1. Check if remainder text is correctly prepended to each pre-chunk
2. Verify the cleaning process isn't accidentally removing remainder text
3. Ensure chunk boundaries are properly calculated
4. Check if the text sent to LLM matches expectations

## Common Issues

- **Missing Remainder**: Check if remainder is being correctly carried forward
- **Text Removal Issues**: Verify if the cleaning process is removing important text
- **Boundary Mismatches**: Ensure chunk boundaries align with semantic breaks

## Database and Storage

### Document Storage Process

Documents are saved in the database only once but updated as processing completes:

1. **Initial Document Save**: At the start of document processing
   - Creates a new document record with `status: 'pending'`
   - Sets the content hash based on document content
   - Creates a document_sources record with the group_number
   - Returns the document ID for later reference

2. **Direct Chunk Saving**: After processing is complete
   - Chunks are saved directly to the chunks table
   - No second call to saveAnalysis to avoid duplication 
  
3. **Document Update**: After chunks are saved
   - Updates the original document record 
   - Sets `status: 'processed'`
   - Remainder text is kept in memory only, not stored in the database

```javascript
// 1. Initial save in cleanAndChunkDocument function
const document = await saveAnalysis(content, skipMetadata ? 'cleanAndChunk' : 'fullMetadata_only', { 
    filepath,
    groupNumber  // Group number for organization purposes
});

// 2. Save chunks directly to database
const chunksToInsert = finalChunkResult.chunks
    .filter(chunk => chunk.cleanedText && chunk.cleanedText.trim().length > 0)
    .map(chunk => ({
        document_id: document.id,
        document_source_id: document.document_source_id,
        start_index: chunk.startIndex,
        // other fields...
    }));

await supabase.from('chunks').insert(chunksToInsert);

// 3. Update document status (remainder text NEVER stored in database)
await supabase
    .from('documents')
    .update({
        status: 'processed',
        warnings: finalChunkResult.warnings || [],
        updated_at: new Date().toISOString()
    })
    .eq('id', document.id);
```

### Group Parameter Usage

The `groupNumber` parameter is used to organize related documents:

1. It should be passed separately from `content_hash`
2. It gets stored in the `group_number` field in the `document_sources` table
3. It's only needed during the initial document creation
4. It should never be stored in the `content_hash` field of the documents table

**Important**: The group number is only passed during the initial document creation, not during the update.

### Content Hash

The content hash serves a different purpose:

1. It's calculated based on the document content
2. It's used for deduplication detection
3. It should only be updated when the document content changes

The system now correctly separates these concerns to prevent duplicate records. 