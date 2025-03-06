# Remainder Text Handling

## Overview

The Document Analyzer system processes large documents across file boundaries by maintaining "remainder text" - content that spans across document boundaries. This document explains how this mechanism works and recent improvements made to it.

## Remainder Text Concept

Remainder text is content that wasn't included in the semantic chunks of a document and needs to be carried forward to the next document for processing. This allows for complete semantic chunks even when content spans multiple files.

### Key Principles:

1. **In-Memory Approach**: Remainder text is passed in memory between document processing calls
2. **No Database Storage**: Remainder text is never stored in the database
3. **Already Cleaned**: Remainder text is already cleaned and should never be cleaned again
4. **Prepending**: Remainder text is prepended to cleaned text before chunking

## Processing Flow

### Within a Document

1. **Pre-chunks**: Document is divided into fixed-size segments
2. **For each pre-chunk**:
   - Raw pre-chunk is cleaned by removing headers, footers, etc.
   - Remainder from previous iteration is prepended to cleaned text
   - This combined text is sent for semantic chunking
   - After chunking, new remainder is calculated (text after last chunk)

### Between Documents (Continuation)

1. **Passing Remainder**:
   - When document A completes, its final remainder text is returned
   - When processing document B with continuation=true, document A's remainder is passed in
   - Document B starts processing with this remainder already included

2. **Activation**: 
   - Continuation must be explicitly enabled with `--continuation` flag
   - In-memory remainder must be passed directly from previous document

## Implementation Details

### Remainder Initialization 

```javascript
// Initialize remainder text - ONLY use in-memory tracking
let remainderText = '';

// If we have in-memory remainder text, use it directly
if (isContinuation && inMemoryRemainderText !== null) {
    console.log('Using in-memory remainder text from previous document');
    remainderText = inMemoryRemainderText;
    // ...
}
```

### Combining with Cleaned Text

```javascript
// Create the final cleaned text by prepending any remainder text to the cleaned pre-chunk text
finalCleanedText = remainderText + cleanedText;
```

### Calculating New Remainder

```javascript
// The remainder text is everything in finalCleanedText that comes after the last chunk's end
const lastChunk = chunkResult?.chunks?.length > 0 ? chunkResult.chunks[chunkResult.chunks.length - 1] : null;
if (lastChunk && !lastChunk.drop_remaining) {
    // Only update remainderText if the last processed chunk is valid
    remainderText = finalCleanedText.substring(lastChunk.endIndex);
}
```

### Returning for Next Document

```javascript
return {
    chunks: finalChunkResult.chunks,
    remainderText: remainderText,  // Returned for continuation
    warnings: finalChunkResult.warnings
};
```

## Recent Improvements

### 1. Simplification of Remainder Handling

- **Removed Database Dependencies**: Completely eliminated any database storage of remainder text
- **Exclusive In-Memory Approach**: Now uses only in-memory remainder passing
- **Streamlined Commands**: Simplified batch processing to directly pass remainder between documents

### 2. Enhanced Debugging and Monitoring

- **Added Detailed Logging**: Shows remainder text at each step in processing
- **Verification Points**: Confirms proper inclusion of remainder text
- **Buffer Monitoring**: Tracks lengths before and after combining texts

### 3. Fixed Issues

- **Database Errors**: Fixed schema-related errors in document storage
- **Text Continuity**: Ensured remainder text is properly included at start of combined text
- **Batch Processing**: Fixed batch processing to properly pass remainder between files

## Best Practices

1. **Always Use `--continuation` Flag**: When processing a sequence of documents that should be treated as one
2. **Monitor Remainder Lengths**: Unexpected zero-length remainders might indicate processing issues
3. **Check First/Last Characters**: The first characters of processed text should match the last remainder

## Command Example

```
node src/index.mjs batch "path/to/files/*.docx" -t cleanAndChunk --continuation -g myGroup
```

This will process all matching files in sequence, passing remainder text from each document to the next. 