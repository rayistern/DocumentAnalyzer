# Document Chunking System

## Overview
The document chunking system splits text into manageable chunks while maintaining semantic integrity. It uses LLM-suggested boundaries with multiple fallback mechanisms to ensure reliable and consistent chunking.

## Core Mechanisms

### 1. Initial LLM Chunking
- LLM suggests initial chunk boundaries with start/end indices and words
- Each chunk includes metadata about its first and last words
- System expects chunks to end at natural sentence boundaries

### 2. Boundary Adjustments

#### Gap Handling
- **Negative Gaps**: When a chunk tries to start before previous chunk ended
  - Forces chunk to start immediately after previous chunk
  - Uses actual adjusted positions, not LLM suggestions
  
- **Large Positive Gaps**: When gap between chunks exceeds tolerance
  - Forces next chunk to start immediately after previous
  - Prevents loss of text between chunks

#### Length Controls
- **Text Length Overrun**: When chunk tries to end beyond text length
  - Automatically truncates to text length
  - Preserves as much content as possible while maintaining validity

### 3. Position Adjustment System

#### Cumulative Offset Tracking
- Tracks character position differences between LLM and actual text
- Accounts for:
  - Escaped characters
  - Unicode/special characters
  - Whitespace normalization

#### Word Boundary Finding
- Attempts to locate exact words at chunk boundaries
- Uses fuzzy matching with tolerance for truncated words
- Falls back to position-based boundaries if words not found

### 4. Overlap Handling
- CHUNK_END_OVERLAP = 100 characters
- Allows chunks to extend beyond suggested end to avoid mid-sentence cuts
- Uses Math.min() to prevent exceeding text length
- Ensures semantic completeness while maintaining safety

## Validation and Logging

### Chunk Validation
- Validates chunk boundaries against text length
- Checks for gaps between chunks
- Verifies sentence completeness
- Stores warnings in chunk metadata

### Warning Types
1. Chunk end index exceeding text length
2. Negative gaps between chunks
3. Large positive gaps
4. Missing sentence breaks
5. Unprocessed text remaining

## Database Storage
- Stores original and adjusted positions
- Tracks warnings and adjustments
- Maintains metadata about chunk processing
- Records both raw and cleaned text 