import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';
import { logLLMResponse } from './llmLoggingService.mjs';
import { saveAnalysis, saveCleanedDocument } from './supabaseService.mjs';
import { preChunkText, shouldUseSimplifiedPrompt } from './preChunkingService.mjs';
import dotenv from 'dotenv'
import { supabase } from './supabaseService.mjs';
import { retryWithFallback, validateGap } from './errorHandlingService.mjs';
import { parseJsonResponse } from '../utils/jsonUtils.mjs';

dotenv.config()

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;

function supportsJsonFormat(model) {
    return OPENAI_SETTINGS.modelConfig.jsonFormatSupported.some(prefix => model.startsWith(prefix));
}

function createApiOptions(model, messages) {
    return {
        model,
        messages,
        ...(supportsJsonFormat(model) && {
            response_format: { type: "json_object" }
        })
    };
}

export async function processFile(content, type, filepath, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength, overview = '') {
    try {
        switch (type) {
            case 'sentiment':
                return await analyzeSentiment(content);
            case 'chunk':
                return await createChunks(content, maxChunkLength, filepath);
            case 'cleanAndChunk':
                return await cleanAndChunkDocument(content, maxChunkLength, filepath, overview);
            default:
                return await summarizeContent(content);
        }
    } catch (error) {
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

function cleanText(text, textToRemove) {
    let cleanedText = text;
    const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;
    let offset = 0;  // Track how many characters we've removed

    if (textToRemove && Array.isArray(textToRemove)) {
        textToRemove.forEach(item => {
            // IMPORTANT: First try the exact position the LLM gave us
            // Only fall back to searching if that fails
            let found = false;

            // Adjust positions based on how much text we've removed so far
            const adjustedStart = item.startPosition - 1 - offset;
            const adjustedEnd = item.endPosition - offset;

            // Try exact position first
            const exactText = cleanedText.substring(adjustedStart, adjustedEnd);
            if (exactText === item.text) {
                found = true;
                cleanedText = cleanedText.substring(0, adjustedStart) + 
                            cleanedText.substring(adjustedEnd);
                offset += item.text.length;
                console.log(`Removed text at exact position: "${item.text}"`);
            }

            // If exact position fails, search near the position
            if (!found) {
                const searchStart = Math.max(0, adjustedStart - tolerance);
                const searchEnd = Math.min(cleanedText.length, adjustedEnd + tolerance);
                const searchArea = cleanedText.substring(searchStart, searchEnd);
                
                const textPos = searchArea.indexOf(item.text);
                if (textPos !== -1) {
                    found = true;
                    cleanedText = cleanedText.substring(0, searchStart + textPos) + 
                                cleanedText.substring(searchStart + textPos + item.text.length);
                    offset += item.text.length;
                    console.log(`Removed text by position-guided search: "${item.text}"`);
                }
            }

            // If position-based approaches fail, try context matching
            if (!found && item.contextBefore && item.contextAfter) {
                const pattern = escapeRegExp(item.contextBefore + item.text + item.contextAfter);
                const match = cleanedText.match(new RegExp(pattern));
                if (match) {
                    found = true;
                    const matchStart = match.index + item.contextBefore.length;
                    cleanedText = cleanedText.substring(0, matchStart) + 
                                cleanedText.substring(matchStart + item.text.length);
                    offset += item.text.length;
                    console.log(`Removed text by context match: "${item.text}"`);
                } else {
                    // Try with just before or after context
                    const beforePattern = escapeRegExp(item.contextBefore + item.text);
                    const afterPattern = escapeRegExp(item.text + item.contextAfter);
                    
                    const beforeMatch = cleanedText.match(new RegExp(beforePattern));
                    const afterMatch = cleanedText.match(new RegExp(afterPattern));
                    
                    if (beforeMatch) {
                        found = true;
                        const matchStart = beforeMatch.index + item.contextBefore.length;
                        cleanedText = cleanedText.substring(0, matchStart) + 
                                    cleanedText.substring(matchStart + item.text.length);
                        offset += item.text.length;
                        console.log(`Removed text by before-context match: "${item.text}"`);
                    } else if (afterMatch) {
                        found = true;
                        const matchStart = afterMatch.index;
                        cleanedText = cleanedText.substring(0, matchStart) + 
                                    cleanedText.substring(matchStart + item.text.length);
                        offset += item.text.length;
                        console.log(`Removed text by after-context match: "${item.text}"`);
                    }
                }
            }

            // Last resort: if all else fails and text appears exactly once
            if (!found) {
                const matches = cleanedText.match(new RegExp(escapeRegExp(item.text), 'g'));
                if (matches && matches.length === 1) {
                    const matchStart = cleanedText.indexOf(item.text);
                    cleanedText = cleanedText.substring(0, matchStart) + 
                                cleanedText.substring(matchStart + item.text.length);
                    offset += item.text.length;
                    console.log(`Removed text by single exact match: "${item.text}"`);
                } else {
                    console.warn(`Warning: Could not find unique text "${item.text}" at position ${item.startPosition}-${item.endPosition} or with context`);
                }
            }
        });
        cleanedText = cleanedText.replace(/\s+/g, ' ').trim();
    }
    return cleanedText;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeMarkdownFormatting(text) {
    return text.replace(/```[\s\S]*?```/g, match => {
        // Extract content between backticks, removing the first line (```json)
        const content = match.split('\n').slice(1, -1).join('\n');
        return content;
    });
}

async function createChunks(text, maxChunkLength, filepath) {
    try {
        const response = await openai.chat.completions.create(
            createApiOptions(OPENAI_SETTINGS.model, [
                {
                    role: OPENAI_PROMPTS.chunk.role,
                    content: OPENAI_PROMPTS.chunk.content(maxChunkLength)
                },
                {
                    role: "user",
                    content: text
                }
            ])
        );

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);

        const cleanResponse = removeMarkdownFormatting(response.choices[0].message.content);
        const result = parseJsonResponse(cleanResponse);

        if (result.chunks && result.textToRemove) {
            result.chunks = result.chunks.map(chunk => {
                const originalText = text.slice(chunk.startIndex - 1, chunk.endIndex);
                const cleanedText = cleanText(originalText, result.textToRemove);
                return {
                    ...chunk,
                    originalText,
                    cleanedText
                };
            });
        }

        result.warnings = validateChunks(result.chunks, text);
        
        // Store in Supabase
        await saveAnalysis(text, 'chunk', { ...result, filepath });
        
        return result;
    } catch (error) {
        throw new Error(`Chunk creation failed: ${error.message}`);
    }
}

async function summarizeContent(text) {
    try {
        const response = await openai.chat.completions.create(
            createApiOptions(OPENAI_SETTINGS.model, [
                OPENAI_PROMPTS.summarize,
                {
                    role: "user",
                    content: text
                }
            ])
        );

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);
        const result = parseJsonResponse(response.choices[0].message.content);
        
        // Store in Supabase
        await saveAnalysis(text, 'summary', result);
        
        return result;
    } catch (error) {
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    try {
        const response = await openai.chat.completions.create(
            createApiOptions(OPENAI_SETTINGS.model, [
                OPENAI_PROMPTS.sentiment,
                {
                    role: "user",
                    content: text
                }
            ])
        );

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);
        const result = parseJsonResponse(response.choices[0].message.content);
        
        // Store in Supabase
        await saveAnalysis(text, 'sentiment', result);
        
        return result;
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}

function validateChunks(chunks, cleanedText) {
    const documentWarnings = [];
    console.log('\nValidating chunks against cleaned text:', cleanedText);
    
    chunks.forEach((chunk, index) => {
        console.log(`\nValidating chunk ${index + 1}:`, chunk);
        const chunkWarnings = [];
        
        if (chunk.startIndex !== (index === 0 ? 1 : chunks[index - 1].endIndex + 1)) {
            const gapText = cleanedText.slice(index === 0 ? 0 : chunks[index - 1].endIndex, chunk.startIndex - 1);
            const gapValidation = validateGap(gapText);
            chunkWarnings.push(gapValidation.message);
        }

        const chunkText = cleanedText.slice(chunk.startIndex - 1, chunk.endIndex);
        console.log(`Chunk text from cleaned text: "${chunkText}"`);
        const endsWithPeriod = chunkText.trim().match(/[.!?]$/);

        if (!endsWithPeriod) {
            chunkWarnings.push(`Does not end with a sentence break: "${chunkText}"`);
        }

        const chunkLength = chunk.endIndex - chunk.startIndex + 1;
        if (chunkLength > OPENAI_SETTINGS.defaultMaxChunkLength) {
            chunkWarnings.push(`Exceeds maximum length (${chunkLength} > ${OPENAI_SETTINGS.defaultMaxChunkLength})`);
        }

        chunk.warnings = chunkWarnings;
        if (chunkWarnings.length > 0) {
            documentWarnings.push(`Chunk ${index + 1} has warnings: ${chunkWarnings.join(', ')}`);
        }
    });

    if (chunks[chunks.length - 1].endIndex < cleanedText.length) {
        const remainingText = cleanedText.slice(chunks[chunks.length - 1].endIndex);
        documentWarnings.push(`Unprocessed text remaining: "${remainingText}"`);
    }

    return documentWarnings;
}

function findCompleteBoundary(text, position, word) {
    // Look for the word within tolerance range
    const start = Math.max(0, position - tolerance);
    const end = Math.min(text.length, position + tolerance);
    const searchText = text.substring(start, end);
    
    const wordIndex = searchText.indexOf(word);
    if (wordIndex !== -1) {
        return start + wordIndex;
    }
    
    return position;
}

async function cleanAndChunkDocument(text, maxChunkLength, filepath, overview) {
    try {
        console.log('Starting clean and chunk process...');
        
        // First save the original document to get an ID
        const document = await saveAnalysis(text, 'cleanAndChunk', { filepath });
        console.log('Saved original document with ID:', document.id);

        // Create new session for this document
        const currentSession = {
            messages: [],
            documentId: document.id
        };

        // Pre-chunk the text
        const preChunks = preChunkText(text, OPENAI_SETTINGS.preChunkSize);
        console.log(`Created ${preChunks.length} pre-chunks`);
        
        let cleanedChunks = [];
        let allTextToRemove = [];
        let remainderText = '';
        let finalCleanedText = '';  // Store the complete cleaned text

        // Process each pre-chunk
        for (let i = 0; i < preChunks.length; i++) {
            console.log(`\nProcessing pre-chunk ${i + 1}/${preChunks.length}...`);
            
            // Combine remainder with current chunk
            const chunk = preChunks[i];
            const combinedText = remainderText + chunk.text;
            console.log(`Combined text length: ${combinedText.length} (${remainderText.length} from remainder)`);

            // Save this pre-chunk to database (after combining with remainder)
            const { error: prechunkError } = await supabase
                .from('prechunks')
                .insert({
                    document_id: document.id,
                    chunk_index: i,
                    text: chunk.text,
                    start_position: chunk.startPosition,
                    end_position: chunk.endPosition,
                    is_complete: Boolean(chunk.isComplete),
                    created_at: new Date().toISOString(),
                    remainder_text: remainderText,
                    remainder_length: remainderText.length
                });

            if (prechunkError) {
                console.error(`Error saving pre-chunk ${i + 1}:`, prechunkError);
            } else {
                console.log(`Saved pre-chunk ${i + 1} to database`);
            }

            // Step 1: Clean the text chunk using LLM
            console.log('Cleaning text chunk...');
            const cleanResponse = await openai.chat.completions.create(
                createApiOptions(OPENAI_SETTINGS.model, [
                    OPENAI_PROMPTS.cleanAndChunk.clean('', !chunk.isComplete),
                    {
                        role: "user",
                        content: combinedText
                    }
                ])
            );

            console.log('Clean response received');
            await logLLMResponse(null, cleanResponse.choices[0].message.content, OPENAI_SETTINGS.model);
            const cleanResult = parseJsonResponse(cleanResponse.choices[0].message.content);
            console.log('Parsed clean result');
            
            // Adjust positions of textToRemove based on chunk start position
            // This is needed because the LLM returns positions relative to the text it sees,
            // but we need positions relative to the original document
            if (cleanResult.textToRemove) {
                cleanResult.textToRemove = cleanResult.textToRemove.map(item => ({
                    ...item,
                    startPosition: item.startPosition + chunk.startPosition - remainderText.length - 1,
                    endPosition: item.endPosition + chunk.startPosition - remainderText.length - 1
                }));
                allTextToRemove = [...allTextToRemove, ...cleanResult.textToRemove];
            }

            // Clean the combined text by removing unwanted text segments
            const cleanedText = cleanText(combinedText, cleanResult.textToRemove);
            finalCleanedText += cleanedText;  // Accumulate cleaned text
            console.log(`Cleaned text length: ${cleanedText.length}`);
            console.log('First 100 chars of cleaned text:', cleanedText.substring(0, 100));

            // Get metadata for the cleaned text
            console.log('\nGetting metadata for cleaned text...');
            const metadataResponse = await openai.chat.completions.create(
                createApiOptions(OPENAI_SETTINGS.model, [
                    OPENAI_PROMPTS.cleanAndChunk.fullMetadata(),
                    {
                        role: "user",
                        content: cleanedText
                    }
                ])
            );
            const metadata = parseJsonResponse(removeMarkdownFormatting(metadataResponse.choices[0].message.content));
            console.log('Metadata generated');

            // Store metadata with document
            const { error: metadataError } = await supabase
                .from('documents')
                .update({ 
                    long_description: metadata.longDescription,
                    keywords: metadata.keywords,
                    questions_answered: metadata.questionsAnswered,
                    updated_at: new Date().toISOString()
                })
                .eq('id', document.id);

            if (metadataError) {
                console.error('Error saving metadata:', metadataError);
            } else {
                console.log('Saved metadata to document');
            }

            // Send cleaned text to LLM for semantic chunking
            console.log('\nText being sent to LLM for chunking:');
            console.log('----------------------------------------');
            console.log(cleanedText);
            console.log('----------------------------------------\n');
            
            const messages = [
                OPENAI_PROMPTS.cleanAndChunk.chunk(maxChunkLength, !chunk.isComplete),
                {
                    role: "user",
                    content: cleanedText
                }
            ];

            // Log the full API call for debugging
            console.log('\nFull API call:');
            console.log('----------------------------------------');
            console.log(JSON.stringify({
                model: OPENAI_SETTINGS.model,
                messages,
                response_format: { type: "json_object" }
            }, null, 2));
            console.log('----------------------------------------\n');
            
            // Get semantic chunks from LLM
            const chunkResponse = await openai.chat.completions.create(
                createApiOptions(OPENAI_SETTINGS.model, messages)
            );

            // Log and parse LLM's chunking response
            console.log('\nLLM Response Analysis:');
            console.log('----------------------------------------');
            const parsedResponse = parseJsonResponse(removeMarkdownFormatting(chunkResponse.choices[0].message.content));
            if (parsedResponse.chunks) {
                console.log(`Number of chunks returned: ${parsedResponse.chunks.length}`);
                parsedResponse.chunks.forEach((c, i) => {
                    console.log(`\nChunk ${i + 1}:`);
                    console.log(`Start: ${c.startIndex}, End: ${c.endIndex}`);
                    console.log(`Text: ${c.cleanedText}`);
                });
            }
            console.log('----------------------------------------\n');

            const chunkResult = parsedResponse;

            // Process chunks and determine remainder text for next iteration
            if (chunkResult.chunks) {
                // Log pre-chunk information for debugging
                console.log('\nPre-chunk info:');
                console.log(`Start position: ${chunk.startPosition}`);
                console.log(`End position: ${chunk.endPosition}`);
                console.log(`Remainder length: ${remainderText.length}`);
                console.log(`Combined text length: ${combinedText.length}`);
                console.log(`Cleaned text length: ${cleanedText.length}`);

                let cumulativeOffset = 0;  // Track character position differences between what LLM sees vs actual text
                chunkResult.chunks = chunkResult.chunks.map((c, index) => {
                    // Debug output
                    console.log('\n=== Chunk processing ===');
                    console.log('LLM returned:');
                    console.log(`- Positions: ${c.startIndex}-${c.endIndex}`);
                    console.log(`- First word: "${c.firstWord}"`);
                    console.log(`- Last word: "${c.lastWord}"`);
                    console.log(`- Full text:\n${c.cleanedText}`);
                    
                    // The LLM's character counting can differ from our text due to:
                    // 1. Escaped characters being counted differently
                    // 2. Unicode/special characters being interpreted differently
                    // 3. Whitespace normalization
                    // So we need to adjust positions using a cumulative offset
                    const suggestedStartIndex = c.startIndex + cumulativeOffset;
                    const suggestedEndIndex = c.endIndex + cumulativeOffset;
                    
                    // Find the actual positions of first/last words within a tolerance range
                    // This is needed because the LLM's word boundaries might not exactly match ours
                    const adjustedStartIndex = findCompleteBoundary(cleanedText, suggestedStartIndex, c.firstWord);
                    const adjustedEndIndex = findCompleteBoundary(cleanedText, suggestedEndIndex, c.lastWord) + c.lastWord.length;
                    
                    // Update cumulative offset for next chunk
                    // If this chunk was off by N characters, the next chunk's positions 
                    // will likely be off by the same amount
                    const newOffset = suggestedEndIndex - adjustedEndIndex;
                    cumulativeOffset -= newOffset;
                    console.log(`Position adjustments:`);
                    console.log(`- Original start: ${c.startIndex}, end: ${c.endIndex}`);
                    console.log(`- Adjusted start: ${adjustedStartIndex + 1}, end: ${adjustedEndIndex}`);
                    console.log(`- Offset this chunk: ${newOffset}, Cumulative: ${cumulativeOffset}`);

                    const extractedText = cleanedText.substring(adjustedStartIndex, adjustedEndIndex);
                    
                    // Find where the period actually is for validation
                    const periodIndex = cleanedText.indexOf('.', adjustedStartIndex);
                    console.log('\nPosition analysis:');
                    console.log(`- LLM wants to end at: ${c.endIndex}`);
                    console.log(`- Next period is at: ${periodIndex}`);
                    console.log(`- Text up to period:\n${cleanedText.substring(adjustedStartIndex, periodIndex + 1)}`);
                    console.log(`- Text after period:\n${cleanedText.substring(periodIndex + 1, c.endIndex)}`);
                    
                    // Check if our position adjustments stayed within tolerance
                    const positionDifference = Math.abs(suggestedEndIndex - adjustedEndIndex);
                    const withinTolerance = positionDifference <= tolerance;
                    
                    // Verify first/last words with fuzzy matching since LLM might:
                    // 1. Normalize words (e.g., remove punctuation)
                    // 2. Standardize quotes/apostrophes
                    // 3. Handle compound words differently
                    const words = extractedText.trim().split(/\s+/);
                    const actualFirstWord = words[0];
                    const actualLastWord = words[words.length - 1];
                    
                    const fuzzyMatch = (word1, word2) => {
                        if (word1 === word2) return true;
                        // Allow one character difference for minor normalization issues
                        if (Math.abs(word1.length - word2.length) > 1) return false;
                        let differences = 0;
                        for (let i = 0; i < Math.max(word1.length, word2.length); i++) {
                            if (word1[i] !== word2[i]) differences++;
                            if (differences > 1) return false;
                        }
                        return true;
                    };
                    
                    const firstWordMatch = fuzzyMatch(actualFirstWord, c.firstWord);
                    const lastWordMatch = fuzzyMatch(actualLastWord, c.lastWord);
                    
                    console.log('\nWord matching:');
                    console.log(`- First word match: ${firstWordMatch ? 'YES' : 'NO'}`);
                    console.log(`  LLM: "${c.firstWord}"`);
                    console.log(`  Our: "${actualFirstWord}"`);
                    console.log(`- Last word match: ${lastWordMatch ? 'YES' : 'NO'}`);
                    console.log(`  LLM: "${c.lastWord}"`);
                    console.log(`  Our: "${actualLastWord}"`);
                    console.log(`- Within tolerance: ${withinTolerance ? 'YES' : 'NO'}`);
                    console.log(`  LLM wanted: ${suggestedEndIndex}`);
                    console.log(`  We found: ${adjustedEndIndex}`);
                    console.log(`  Difference: ${positionDifference} chars`);
                    
                    return {
                        startIndex: adjustedStartIndex + 1, // Keep 1-indexed for consistency with LLM
                        endIndex: adjustedEndIndex,
                        firstWord: actualFirstWord,
                        lastWord: actualLastWord,
                        cleanedText: extractedText,
                        original_text: chunk.text, // Store the original chunk text
                        first_word_match: firstWordMatch,
                        last_word_match: lastWordMatch,
                        within_tolerance: withinTolerance,
                        position_difference: positionDifference,
                        llm_suggested_end: suggestedEndIndex,
                        actual_end: adjustedEndIndex
                    };
                });

                // Get remainder text for next iteration
                // This is text after the last chunk that will be combined with the next pre-chunk
                const lastChunk = chunkResult.chunks[chunkResult.chunks.length - 1];
                remainderText = cleanedText.substring(lastChunk.endIndex);
                console.log(`\nRemainder text length: ${remainderText.length}`);
                if (remainderText.length > 0) {
                    console.log(`Remainder starts with: "${remainderText.slice(0, 50)}..."`);
                }

                // Accumulate processed chunks
                cleanedChunks = [...cleanedChunks, ...chunkResult.chunks];
                
                // Save chunks to database immediately to preserve progress
                // This ensures we don't lose work if processing fails later
                const { error: chunksError } = await supabase
                    .from('chunks')
                    .insert(chunkResult.chunks.map(c => ({
                        document_id: document.id,
                        document_source_id: document.document_source_id,
                        start_index: c.startIndex,
                        end_index: c.endIndex,
                        first_word: c.firstWord,
                        last_word: c.lastWord,
                        cleaned_text: c.cleanedText,
                        original_text: c.original_text,
                        warnings: Array.isArray(c.warnings) ? c.warnings.join('\n') : null,
                        first_word_match: c.first_word_match,
                        last_word_match: c.last_word_match,
                        within_tolerance: c.within_tolerance,
                        position_difference: c.position_difference,
                        llm_suggested_end: c.llm_suggested_end,
                        actual_end: c.actual_end,
                        created_at: new Date().toISOString()
                    })));

                if (chunksError) {
                    console.error('Error saving chunks:', chunksError);
                } else {
                    console.log(`Saved ${chunkResult.chunks.length} chunks to database`);
                }
            } else {
                // If LLM didn't return chunks, treat entire cleaned text as remainder
                remainderText = cleanedText;
                console.log('No chunks returned, entire text is remainder');
            }
        }

        // Handle final remainder if any
        if (remainderText.trim()) {
            console.log(`Processing final remainder of length ${remainderText.length}`);
            cleanedChunks.push({
                startIndex: text.length - remainderText.length + 1,
                endIndex: text.length,
                cleanedText: remainderText,
                firstWord: remainderText.trim().split(/\s+/)[0],
                lastWord: remainderText.trim().split(/\s+/).pop()
            });
        }

        const warnings = validateChunks(cleanedChunks, text);
        console.log('Validation warnings:', warnings);

        const result = {
            textToRemove: allTextToRemove,
            chunks: cleanedChunks,
            warnings
        };

        // Store chunks in database
        console.log('Storing results in database...');
        await saveAnalysis(text, 'chunk', { 
            ...result, 
            filepath,
            document_source_id: document.document_source_id,
            document: document,
            skipChunkSave: true  // Add flag to skip chunk saving in saveAnalysis
        });
        
        // Generate metadata for chunks
        if (cleanedChunks.length > 0) {
            console.log(`\nGenerating metadata for ${cleanedChunks.length} chunks...`);
            for (let i = 0; i < cleanedChunks.length; i++) {
                const chunk = cleanedChunks[i];
                console.log(`\nGenerating metadata for chunk ${i + 1}/${cleanedChunks.length}...`);
                try {
                    const metadata = await generateMetadata(chunk);
                    console.log('Metadata response received');
                    chunk.metadata = metadata;
                    console.log('Metadata parsed and stored in chunk');
                    
                    // Update metadata in database
                    console.log('Updating metadata in database...');
                    const { error: updateError } = await supabase
                        .from('chunks')
                        .update({ 
                            raw_metadata: metadata
                        })
                        .eq('document_id', document.id)
                        .eq('start_index', chunk.startIndex);

                    if (updateError) {
                        console.error(`Error updating metadata in database: ${updateError.message}`);
                    }
                } catch (metadataError) {
                    console.error(`Error generating metadata for chunk ${i + 1}:`, metadataError);
                }
            }
        }
        
        // Update document with final cleaned text
        await saveCleanedDocument(document.id, finalCleanedText, text, OPENAI_SETTINGS.model);
        
        return result;
    } catch (error) {
        console.error('Clean and chunk error:', error);
        throw new Error(`Clean and chunk operation failed: ${error.message}`);
    }
}

async function generateMetadata(chunk) {
    return retryWithFallback(async (model) => {
        const response = await openai.chat.completions.create(
            createApiOptions(model, [
                OPENAI_PROMPTS.metadata(),
                { role: "user", content: chunk.cleanedText }
            ])
        );
        return response.choices[0].message.content;
    });
}