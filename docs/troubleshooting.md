# Troubleshooting Guide

## Common Issues and Solutions

This guide covers common issues encountered with the Document Analyzer system and their solutions, with special focus on the remainder text handling and database interactions.

## Remainder Text Issues

### Issue: Remainder Text Not Being Passed Between Documents

**Symptoms**:
- Log shows "Continuation requested but no remainder text available"
- Documents processed as individual units despite continuation flag

**Solutions**:
1. Ensure the `--continuation` flag is set in the batch command
2. Verify that the batch process isn't interrupted between files
3. Check that `remainderText` is being properly returned from `cleanAndChunkDocument`
4. Confirm that `inMemoryRemainderText` is being passed correctly in function calls

**Example Fix**:
```javascript
// Update in-memory remainder for next file
if (result.remainderText) {
    remainderText = result.remainderText;
    console.log(`Stored remainder text for next file (${remainderText.length} chars)`);
}
```

### Issue: Remainder Text Appears to be Lost During Processing

**Symptoms**:
- Remainder text length suddenly becomes zero
- Text continuity breaks between documents

**Solutions**:
1. Check log sections "REMAINDER-TRACK" to find where remainder becomes zero
2. Verify combination of remainder with cleaned text:
   ```javascript
   // Should show length > 0 if remainder exists
   console.log("REMAINDER-TRACK: Combined text length = " + finalCleanedText.length + " chars");
   ```
3. Ensure the LLM chunking response is correctly handling text with remainder prepended

## Database Issues

### Issue: "null value in column violates not-null constraint"

**Symptoms**:
- Error when saving documents: `null value in column "filename" of relation "document_sources" violates not-null constraint`
- Error when saving documents: `null value in column "original_filename" of relation "documents" violates not-null constraint`

**Solutions**:
1. Ensure `filepath` is passed to `saveAnalysis` function:
   ```javascript
   await saveAnalysis(text, 'cleanAndChunk', { 
       filepath: filename,
       // other parameters
   });
   ```
2. Check that the database schema matches expected fields:
   ```sql
   -- document_sources must have:
   filename TEXT NOT NULL,
   
   -- documents must have:
   original_filename TEXT NOT NULL,
   ```

### Issue: "Could not find column in schema cache"

**Symptoms**:
- Error: `Could not find the 'group_number' column of 'documents' in the schema cache`

**Solutions**:
1. Ensure you're only storing group_number in the correct table (document_sources)
2. Check for typos in column names
3. Update schema if needed: 
   ```sql
   ALTER TABLE document_sources ADD COLUMN IF NOT EXISTS group_number TEXT;
   ```

## Processing Flow Issues

### Issue: Chunks Have Incorrect Text or Breaks

**Symptoms**:
- Chunks don't end at logical sentence breaks
- Text appears to be duplicated or missing

**Solutions**:
1. Check the raw chunks API response:
   ```
   LLM Response Analysis:
   Number of chunks returned: X
   Chunk 1: Start: Y, End: Z
   ```
2. Verify the max chunk length parameter is appropriate
3. Check if remainder text is properly combined with cleaned text
4. Examine the validation warnings for chunks

### Issue: Continuation Creates Duplicate Content

**Symptoms**:
- Same text appears in multiple chunks across documents

**Solutions**:
1. Verify that remainder text is being properly identified as the text after the last chunk
2. Check that processing includes remainder at the beginning of next document
3. Review the index calculations when creating chunks

### Issue: Chunks Have Incorrect Text or Boundaries

**Symptoms**:
- Text appears cut off mid-word
- Chunks contain wrong text compared to original document
- Missing words at chunk boundaries

**Solutions**:
1. Check the position adjustment logs in the console output:
   ```
   findWordPosition input values:
   - Target word: "example"
   - Original nearPosition: 150
   - Text length: 1000
   - Previous chunk end: 100
   ```

2. Look for warnings about word boundary detection failures:
   ```
   No match found for "targetWord" near 250
   Using safe start position: 251
   ```

3. Check for cumulative offset issues:
   ```
   Position drift: 5 characters from LLM's calculation
   ```

4. If text includes special characters or Unicode, position calculations may be off. Try:
   ```
   First chars of text (hex): 61 62 20 63 64 20
   ```

5. Look at extracted chunk text stats:
   ```
   Chunk text stats: length=250, words=45, first=FirstWord, last=LastWord
   ```

### Issue: Empty or Missing Chunks

**Symptoms**:
- Chunks filter shows "No valid chunks to insert after filtering"
- Chunks have positions but no text content
- Gaps between chunks in the database

**Solutions**:
1. If the LLM returns positions but no text:
   ```
   Warning: Missing boundary words for chunk 150-300
   ```
   The system will try to extract text from the positions, check if this extraction worked:
   ```
   Re-extracted text with adjusted boundaries
   ```

2. If chunk positions are invalid (start >= end):
   ```
   Warning: Invalid chunk positions (start=300 >= end=200)
   ```
   Look for issues in the offset calculation or LLM response format.

3. Add more detail to the extracted text logs by setting debugging level higher in `settings.mjs`:
   ```javascript
   debug: {
     showExtractedText: true,
     verbosePositionLogs: true
   }
   ```

4. If chunks are too small or too large, check the LLM's chunking configuration:
   ```
   Max chunk length: 2000
   ```

## Logging and Debugging

### Enabling Enhanced Logging

For more detailed troubleshooting, use these logging points:

1. **Text Flow Logging**:
   ```
   debugLogText("RAW PRE-CHUNK TEXT (SENT FOR CLEANING)", text, false);
   debugLogText("TEXT AFTER CLEANING (BEFORE COMBINING WITH REMAINDER)", cleanedText, false);
   ```

2. **Remainder Tracking**:
   ```
   console.log(`[TRACK] remainderText before combining: ${remainderText.length} chars`);
   console.log(`REMAINDER-TRACK: Combined text length = ${finalCleanedText.length} chars`);
   ```

3. **Verification Points**:
   ```
   console.log(`VERIFICATION - Text includes remainder: ${textIncludesRemainder ? 'YES' : 'NO'}`);
   ```

### Reading Log Output

Key log sections to examine:

1. `=== REMAINDER TRACKING ===` - Shows remainder text status
2. `=== DETAILED TEXT FLOW LOGGING ===` - Shows text transformation
3. `CHUNKING API CALL DETAILS` - Shows text sent to LLM
4. `=== FINAL REMAINDER TEXT DETAILS ===` - Shows final remainder for next document

## Performance Issues

### Issue: Processing is Slow

**Symptoms**:
- Batch processing takes excessive time

**Solutions**:
1. Reduce pre-chunk size to process smaller text segments:
   ```javascript
   const preChunks = preChunkText(content, 1000); // Smaller size
   ```
2. Use a faster LLM model in settings
3. Process files in parallel (though this may affect continuation)

## Metadata Processing Issues

### Issue: "TypeError: x.replace is not a function"

**Symptoms**:
- Error in the console: `TypeError: e.replace is not a function` or `TypeError: t.replace is not a function`
- Error occurs during metadata processing in `saveChunkMetadata` function
- Processing terminates for the current chunk but may continue with subsequent chunks

**Cause**:
The error occurs when non-string values are present in array metadata fields, but the code attempts to call string methods on them.

**Solutions**:
1. The code now handles non-string values by converting them to strings:
   ```javascript
   // Updated array handling with type checking
   named_entities: Array.isArray(mappedMetadata.named_entities) ? 
     `{${mappedMetadata.named_entities.map(e => 
       typeof e === 'string' ? `"${e.replace(/"/g, '\\"')}"` : `"${String(e)}"`
     ).join(',')}}` : null
   ```
2. If you encounter this error, update all array field handlers in `saveChunkMetadata` with type checking

## Best Practices for Reliable Processing

1. **Always use in-memory remainder passing** instead of database lookup
2. **Pass explicit filepath parameter** to all relevant functions
3. **Include detailed logging** for critical text transformation steps
4. **Use --continuation flag** when processing multi-file documents
5. **Monitor chunk warnings** for signs of processing problems 