1. Make sure everything hits the dataqbase properly (chunks, prechunks, etc)
2. Get longer strings for beginning/end of chunk. And make sure we chunk before and after those strings.
3. Add chunk verification logging back in
4. Deduplication error
5. Curriculum development
6. Add remainder text to database (for continuations)
7. Add full chunk text option
8. Parse out metadata to appropriate fields in database
9. Handle json parse issues (maybe fall back to other model if errors more than n times)
10. Add double checking / retrying for chunk mismatches
11. Add custom prompt prepending to chunking, etc. (and remove hardcoded likkutei torah.)
12. Seems that the code is still checking for one word sometimes, even though now the LLM is returning more than one word
13. FullMetatada_only is skipping metadata (parsing ot columns) on some lines, and also is saving metadata after creating next file seemingly.
14. Statuses
15. All files seem to be going in with type fullMetadatOnly
16. Double check that chunks within prechunk retain the context. And consider if maybe whenever --continue is passed we always retain context...
17. Check warnings 
⚠️ WARNING: Field "warnings" is undefined in chunk data
⚠️ WARNING: Field "raw_metadata" is null in chunk data
⚠️ WARNING: Field "warnings" is undefined in chunk data
⚠️ WARNING: Field "raw_metadata" is null in chunk data
⚠️ WARNING: Field "warnings" is undefined in chunk data
⚠️ WARNING: Field "raw_metadata" is null in chunk data
⚠️ WARNING: Field "warnings" is undefined in chunk data
⚠️ WARNING: Field "raw_metadata" is null in chunk data
⚠️ WARNING: Field "warnings" is undefined in chunk data
⚠️ WARNING: Field "raw_metadata" is null in chunk data
18. Make chunk search actually work! Try using one word when multiple words fail. see above - still using one word sometimes; retry on fail; fallback models on fail.
19. error here? 
[2025-03-07T22:03:24.522Z] 3. ID: 829e010b... | Filename: 1110-2938.docx | Group: igrosgpt4.5-1a
[2025-03-07T22:03:24.522Z] These entries match the pattern of the unexpected entries you're seeing.
[2025-03-07T22:03:24.522Z] This suggests there might be a database trigger or another process creating these entries.
[2025-03-07T22:03:24.522Z] Current call stack:
Error
    at detectUnexpectedEntries (file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/services/supabaseService.mjs:174:29)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async Command.<anonymous> (file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/index.mjs:246:21)        

[2025-03-07T22:03:24.885Z] 📊 LOGGING ALL DOCUMENT_SOURCES ENTRIES
[2025-03-07T22:03:24.885Z] Found 20 recent entries:
[2025-03-07T22:03:24.885Z] 1. ID: c85856c0... | Filename: 1110-2935.docx | Status: fullMetadata_only | Group: i
20. Failed to parse JSON: Expected ',' or '}' after property value in JSON at position 95
No chunks found in LLM response, initializing empty chunks array
Number of chunks returned: 0
21. Don't chunk in middle of word
22. Other algorithms:
BLEU score
TF-IDF similarity
23. Are we searching only for normalized word or also for normalized word? Same for phrase and same for word - we have to do multiple searches, each type for each type (permutations). 
24. I don't get this logging - did it find it or not? First and/or last? 
Chunk 5:
Original: Start: 1121, End: 1400
After offset adjustment: Start: 1121, End: 1400
Using LLM-provided firstWords: "והיינו בחי' אהוי"ר"
Using LLM-provided lastWords: "יוובן ממש"
Boundary phrases detected:
- First phrase: "והיינו בחי' אהוי"ר"
- Last phrase: "יוובן ממש"

======== WORD BOUNDARY DETECTION - CHUNK 5 ========
Finding exact word boundaries for precise chunking:
- First word to find: "והיינו בחי' אהוי"ר"
- Last word to find: "יוובן ממש"
- Starting search at positions: 1121-1400

findWordPosition input values:
- Target word: "והיינו בחי' אהוי"ר"
- Original nearPosition: 1120
- Text length: 3457
- Previous chunk end: 1119
- Normalized target word: "והיינו בחי אהוי ר"
- Search range: 1085-1155
- Search area length: 70
- No exact match found
Trying normalized match within normal tolerance...

Trying wider search: 1050-1190
No match found for "והיינו בחי' אהוי"ר" near 1120
Using safe start position: 1120

findWordPosition input values:
- Target word: "יוובן ממש"
- Original nearPosition: 1399
- Text length: 3457
- Previous chunk end: 1120
- Normalized target word: "יוובן ממש"
- Search range: 1364-1434
- Search area length: 70
- No exact match found
Trying normalized match within normal tolerance...

Trying wider search: 1329-1469
No match found for "יוובן ממש" near 1399
Intended length from near position: 279
Using safe end position: 1399 (minLength: 279)

WORD BOUNDARY RESULTS:
- Original positions: 1121-1400
- Final adjusted positions: 1121-1400
- Position change: start 0, end 0
======== END WORD BOUNDARY DETECTION ========

Position drift: 0 characters from LLM's calculation (will be applied to future chunks)
Final text: בחי' ריבוי הצמצומים הנק' גבורו...
25. 
[2025-03-11T19:11:53.570Z] ⏱️ Setting up automatic timeout after 10 hours
Failed to parse JSON: Expected ',' or '}' after property value in JSON at position 4074
Saving metadata for chunk 2...
Saving metadata for document 2295dc09-a2a1-41bd-8c91-9a8ee6ef755e, chunk 1...
Raw metadata for chunk 1: {"textToRemove":[]}...
26. Maybe fixed: Database error: t.replace is not a function
Full error: {}
Error processing metadata for chunk 3: TypeError: t.replace is not a function
    at file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/services/supabaseService.mjs:638:119
    at Array.map (<anonymous>)
    at saveChunkMetadata (file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/services/supabaseService.mjs:638:104)
    at cleanAndChunkDocument (file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/services/openaiService.mjs:1695:39)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async processFile (file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/services/openaiService.mjs:79:24)    at async Command.<anonymous> (file:///C:/Scripts/git/chunking/copy-of-documentAnalyzer/DocumentAnalyzer/src/index.mjs:219:36)        
----- Completed processing for chunk 3/5 -----
27. Why does text searching work for text to remove but not for chunking? Replicate all logic...
28. Clearly define all searching logic...
29. Remove delays
30. In chunk 7 there's mentions of chunk 6. Maybe a 1/0 index technicality.
31. Errors when starting up -fullMetadata_only process (Schema cache or something)
32. How could last word matchbe true and following start matchbe false (or vice versa)? Update defaults...; make sure all is in order now.... (no gaps, etc)
33. Please check if we have any context or session handling in our code already. Can you please create context management. All messages to the AI should be within a context / conversation / session. The conversation will extend across different documents. We can truncate based on a specified number of how many documents, as configured in the config file. This will apply to both batch processing and to one off processing. There should be a flag --noContext to turn off the context feature, and that would just send each message to the LLM as a standalone. Also, in the settings.mjs file, we should have an option on each prompt if to include it within the conversation or to excluded that prompt and have it always function as a standalone.
34. Chunk_metadata llm model in database
35. Add overview into more prompts
36. Clean up files outside of main folder
37. Clean up documentation
38. Add a parameter somewhere where the LLM can tell us if he thinks that the text ends at a natural break.
39. Why do we have so many single letters or sub words as first_word or last_word in the chunks table?
40. Remove unused and likely erroneous processes: createChunks, summarize, sentiment, etc.
41. Still getting fields at end of qa pair
42. Maybe its taking transliteration a bit too intensly
43. Pad documents in order to go in order
44. Model using crazy amounts of tokens sometimes
45. Can you please set up the same parsing logic for the fullMetadata output which goes into the documents table. That one often fails as well.
46. Can we pass a token limit with the metadata call. That one often results in massively long trailing whitespace or something, using 5x the amount of tokens as a standard call.
47. Automatic email-triggered process quitting
48. Test timeout
49. Mini model hallucinates
50. Batch usage
51. Make sure regex json processing extends to all fields
52. Add title into database (chunkMetadata?)
53. Whats the value being saved into remainder_text in prechunks?
54. Where is the cleaned text saved to?