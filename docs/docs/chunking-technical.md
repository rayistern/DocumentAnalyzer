# Chunking System: Technical Reference

## Key Constants
```javascript
CHUNK_END_OVERLAP = 100           // Maximum overlap allowed at chunk ends
maxTolerance = configurable       // Maximum allowed gap between chunks
```

## Data Structures

### Chunk Object
```javascript
{
    startIndex: number,           // 1-indexed start position
    endIndex: number,            // End position
    firstWord: string,           // First word in chunk
    lastWord: string,            // Last word in chunk
    cleanedText: string,         // Processed chunk text
    original_text: string,       // Pre-cleaning text
    warnings: string[],          // Array of warning messages
    first_word_match: boolean,   // If first word was found as expected
    last_word_match: boolean,    // If last word was found as expected
    within_tolerance: boolean,    // If position adjustments stayed within tolerance
    position_difference: number,  // Difference from LLM suggestion
    llm_suggested_end: number,   // Original LLM end position
    actual_end: number           // Final adjusted end position
}
```

## Key Algorithms

### 1. Gap Detection and Handling
```javascript
const gap = startIndex - (previousAdjustedEnd + 1);

if (gap < 0) {
    // Handle negative overlap
    startIndex = previousAdjustedEnd + 1;
} else if (gap > maxTolerance) {
    // Handle large gaps
    startIndex = previousAdjustedEnd + 1;
}
```

### 2. Length Control
```javascript
endIndex = Math.min(endIndex, cleanedText.length);
```

### 3. Position Adjustment
```javascript
const suggestedStartIndex = startIndex + cumulativeOffset;
const suggestedEndIndex = endIndex + cumulativeOffset;
```

## Error Handling

### Warning Categories
1. Boundary Violations
   - Text length exceeded
   - Negative gaps
   - Excessive gaps

2. Content Issues
   - Incomplete sentences
   - Missing word boundaries
   - Unprocessed text

### Database Error Handling
- Immediate chunk saving for progress preservation
- Raw response storage on parsing failures
- Status tracking for incomplete processing

## Performance Considerations

### Memory Usage
- Processes text in pre-chunks
- Maintains running state of:
  - Previous chunk end
  - Cumulative offset
  - Cleaned text accumulation

### Optimization Points
1. Word boundary search uses tolerance window
2. Fuzzy matching for word detection
3. Immediate database writes for resilience

## Integration Points

### LLM Interface
- Expects JSON response with chunk boundaries
- Handles malformed responses gracefully
- Supports multiple LLM models

### Database Schema Dependencies
- chunks table
- documents table
- document_remainders table
- document_sources table

## Debugging

### Key Log Points
```javascript
console.log(`Negative gap detected (${gap})`);
console.log(`Adjusted end index from ${c.endIndex} to ${endIndex}`);
console.log(`Position adjustments: ${positionDifference} chars`);
```

### Common Issues
1. Unicode character handling
2. Whitespace normalization
3. Escaped character counting
4. Position drift in long documents 