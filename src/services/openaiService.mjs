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
    const options = {
        model,
        messages
    };
    
    // Only add response_format for models that explicitly support it
    if (model.startsWith('gpt-4o')) {
        options.response_format = { type: "json_object" };
    }
    
    return options;
}

function getModelForOperation(operation) {
    return OPENAI_SETTINGS.modelConfig.operations[operation] || OPENAI_SETTINGS.model;
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
            createApiOptions(getModelForOperation('chunk'), [
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

        result.warnings = validateChunks(result.chunks, cleanResponse);
        
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
            createApiOptions(getModelForOperation('summarize'), [
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
            createApiOptions(getModelForOperation('sentiment'), [
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
        
        if (index > 0) {
            const gap = chunk.startIndex - chunks[index - 1].endIndex - 1;
            if (gap > 0) {
                const gapText = cleanedText.slice(chunks[index - 1].endIndex, chunk.startIndex - 1);
                const gapValidation = validateGap(gapText);
                chunkWarnings.push(gapValidation.message);
            }
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

        // Constants for chunk boundary handling
        const CHUNK_END_OVERLAP = 100; // How much extra text to include at end of chunk for context overlap

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
                createApiOptions(getModelForOperation('clean'), [
                    OPENAI_PROMPTS.cleanAndChunk.clean('', !chunk.isComplete),
                    {
                        role: "user",
                        content: combinedText
                    }
                ])
            );

            console.log('Clean response received');
            await logLLMResponse(null, cleanResponse.choices[0].message.content, OPENAI_SETTINGS.model);
            let cleanResult;
            try {
                cleanResult = parseJsonResponse(cleanResponse.choices[0].message.content);
            } catch (parseError) {
                console.warn('Failed to parse LLM response as JSON, storing raw response:', parseError.message);
                // Store the raw response and continue
                const { error: rawError } = await supabase
                    .from('documents')
                    .update({ 
                        raw_llm_response: cleanResponse.choices[0].message.content,
                        status: 'parse_error',
                        error_message: parseError.message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', document.id);
                
                if (rawError) {
                    console.error('Error storing raw response:', rawError);
                }
                // Return empty result to continue processing
                cleanResult = { textToRemove: [] };
            }
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

            // Update document with current cleaned text
            await saveCleanedDocument(document.id, finalCleanedText, text, OPENAI_SETTINGS.model);

            // Get metadata for the cleaned text
            console.log('\nGetting metadata for cleaned text...');
            const metadataResponse = await openai.chat.completions.create(
                createApiOptions(getModelForOperation('metadata'), [
                    OPENAI_PROMPTS.cleanAndChunk.fullMetadata(),
                    {
                        role: "user",
                        content: cleanedText
                    }
                ])
            );
            console.log('Full metadata operation used model:', metadataResponse.model);
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
            
            // Get semantic chunks from LLM
            const chunkResponse = await openai.chat.completions.create(
                createApiOptions(getModelForOperation('chunk'), messages)
            );

            // Log and parse LLM's chunking response
            console.log('\nLLM Response Analysis:');
            console.log('----------------------------------------');
            let parsedResponse;
            try {
                parsedResponse = parseJsonResponse(removeMarkdownFormatting(chunkResponse.choices[0].message.content));
            } catch (parseError) {
                console.warn('Failed to parse chunk response as JSON:', parseError.message);
                // Store the raw response and continue
                const { error: rawError } = await supabase
                    .from('documents')
                    .update({ 
                        raw_chunk_response: chunkResponse.choices[0].message.content,
                        status: 'chunk_parse_error',
                        error_message: parseError.message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', document.id);
                
                if (rawError) {
                    console.error('Error storing raw chunk response:', rawError);
                }
                // Return empty result to continue processing
                parsedResponse = { chunks: [] };
            }

            if (parsedResponse.chunks) {
                console.log(`Number of chunks returned: ${parsedResponse.chunks.length}`);
                parsedResponse.chunks.forEach((c, index) => {
                    console.log(`\nChunk ${index + 1}:`);
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
                    // Check if we need to force start after previous chunk
                    let startIndex = c.startIndex;
                    let endIndex = c.endIndex;
                    
                    if (index > 0) {
                        const gap = startIndex - (chunkResult.chunks[index - 1].endIndex + 1);
                        if (gap > OPENAI_SETTINGS.gapConfig.maxTolerance) {
                            startIndex = chunkResult.chunks[index - 1].endIndex + 1;
                            console.log(`Gap of ${gap} exceeds tolerance. Forcing chunk to start at ${startIndex}`);
                        }
                    }
                    
                    // Debug output
                    console.log('\n=== Chunk processing ===');
                    console.log('LLM returned:');
                    console.log(`- Original positions: ${c.startIndex}-${c.endIndex}`);
                    console.log(`- Adjusted start: ${startIndex}, end: ${endIndex}`);
                    console.log(`- First word: "${c.firstWord}"`);
                    console.log(`- Last word: "${c.lastWord}"`);
                    
                    // The LLM's character counting can differ from our text due to:
                    // 1. Escaped characters being counted differently
                    // 2. Unicode/special characters being interpreted differently
                    // 3. Whitespace normalization
                    // So we need to adjust positions using a cumulative offset
                    const suggestedStartIndex = startIndex + cumulativeOffset;
                    const suggestedEndIndex = endIndex + cumulativeOffset;
                    
                    // Find the actual positions of first/last words within a tolerance range
                    // This is critical for ensuring our chunks start/end exactly where the LLM intended
                    // Chunking strategy:
                    // 1. For chunk starts: Try to find LLM's word, fall back to previous chunk end (or doc start)
                    // 2. For chunk ends: Try to find LLM's word, if not found add overlap to avoid cutting mid-sentence
                    const findWordPosition = (text, targetWord, nearPosition, isStart, previousChunkEnd = 0) => {
                        // For start positions, just search within tolerance
                        // For end positions, only add overlap if we can't find the word
                        const searchStart = Math.max(0, nearPosition - tolerance);
                        const searchEnd = Math.min(text.length, nearPosition + tolerance);
                        const searchArea = text.substring(searchStart, searchEnd);
                        
                        // First try exact match
                        const exactIndex = searchArea.indexOf(targetWord);
                        if (exactIndex !== -1) {
                            const foundPosition = searchStart + exactIndex;
                            console.log(`Found exact match "${targetWord}" at position ${foundPosition}`);
                            return foundPosition;
                        }

                        // If exact match fails, try fuzzy matching since LLM might truncate words
                        const words = searchArea.split(/\s+/);
                        let bestMatch = null;
                        let bestMatchIndex = -1;
                        let bestMatchDifference = Infinity;

                        for (let i = 0; i < words.length; i++) {
                            const word = words[i];
                            // Allow one character difference for truncation/normalization
                            if (Math.abs(word.length - targetWord.length) <= 1) {
                                let differences = 0;
                                const minLength = Math.min(word.length, targetWord.length);
                                for (let j = 0; j < minLength; j++) {
                                    if (word[j] !== targetWord[j]) differences++;
                                    if (differences > 1) break;
                                }
                                
                                // Track the best fuzzy match we've found
                                if (differences <= 1 && differences < bestMatchDifference) {
                                    bestMatch = word;
                                    bestMatchDifference = differences;
                                    // Find this word's position in the search area
                                    const wordPos = searchArea.indexOf(word);
                                    if (wordPos !== -1) {
                                        bestMatchIndex = searchStart + wordPos;
                                    }
                                }
                            }
                        }

                        if (bestMatchIndex !== -1) {
                            console.log(`Found fuzzy match "${bestMatch}" for target "${targetWord}" at position ${bestMatchIndex}`);
                            return bestMatchIndex;
                        }

                        // If no match found, handle differently for start vs end positions
                        console.error(`Could not find word "${targetWord}" or similar word near position ${nearPosition}`);
                        console.error(`Search area (${searchArea.length} chars): "${searchArea}"`);
                        
                        if (isStart) {
                            // For chunk starts, fall back to end of previous chunk (or start of doc)
                            console.log(`Falling back to previous chunk end: ${previousChunkEnd}`);
                            return previousChunkEnd;
                        } else {
                            // For chunk ends, if we can't find the word, add overlap to avoid cutting mid-sentence
                            const overlapEnd = Math.min(text.length, nearPosition + CHUNK_END_OVERLAP);
                            console.log(`No word match found - using overlapped end position: ${overlapEnd}`);
                            return overlapEnd;
                        }
                    };

                    // Find where the LLM's suggested words actually appear in the text
                    // For the start position, we can use the previous chunk's end as fallback
                    const previousChunkEnd = index > 0 ? chunkResult.chunks[index - 1].endIndex : 0;
                    const adjustedStartIndex = findWordPosition(cleanedText, c.firstWord, suggestedStartIndex, true, previousChunkEnd);
                    
                    // For the end position, we'll allow overlap beyond the LLM's suggestion
                    const adjustedEndIndex = findWordPosition(cleanedText, c.lastWord, suggestedEndIndex, false);
                    
                    // When calculating offsets, we need to ignore the arbitrary overlap we added
                    // This ensures the next chunk's position calculations aren't thrown off
                    const effectiveEndIndex = Math.min(adjustedEndIndex, suggestedEndIndex + tolerance);
                    const newOffset = suggestedEndIndex - effectiveEndIndex;
                    cumulativeOffset -= newOffset;
                    
                    console.log(`Position adjustments:`);
                    console.log(`- Original start: ${c.startIndex}, end: ${c.endIndex}`);
                    console.log(`- Adjusted start: ${adjustedStartIndex + 1}, end: ${adjustedEndIndex}`);
                    console.log(`- Effective end (without overlap): ${effectiveEndIndex}`);
                    console.log(`- Offset this chunk: ${newOffset}, Cumulative: ${cumulativeOffset}`);

                    // Extract the text between our found positions (including overlap)
                    const extractedText = cleanedText.substring(adjustedStartIndex, adjustedEndIndex);
                    
                    // Find where the period actually is for validation
                    const periodIndex = cleanedText.indexOf('.', adjustedStartIndex);
                    console.log('\nPosition analysis:');
                    console.log(`- LLM wants to end at: ${c.endIndex}`);
                    console.log(`- Next period is at: ${periodIndex}`);
                    console.log(`- Text up to period:\n${cleanedText.substring(adjustedStartIndex, periodIndex + 1)}`);
                    console.log(`- Text after period:\n${cleanedText.substring(periodIndex + 1, c.endIndex)}`);
                    
                    // Check if our position adjustments stayed within tolerance
                    const positionDifference = Math.abs(suggestedEndIndex - effectiveEndIndex);
                    const withinTolerance = positionDifference <= tolerance;
                    
                    // Get the actual words we found at our chosen positions for validation
                    const actualFirstWord = cleanedText.substring(adjustedStartIndex).split(/\s+/)[0];
                    const actualLastWord = cleanedText.substring(0, effectiveEndIndex).split(/\s+/).pop();
                    
                    // Check if we found the LLM's suggested words (allowing for truncation)
                    const fuzzyMatch = (word1, word2) => {
                        if (word1 === word2) return true;
                        if (Math.abs(word1.length - word2.length) > 1) return false;
                        let differences = 0;
                        const minLength = Math.min(word1.length, word2.length);
                        for (let i = 0; i < minLength; i++) {
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
                    console.log(`  We found: ${effectiveEndIndex}`);
                    console.log(`  Difference: ${positionDifference} chars`);
                    
                    return {
                        startIndex: adjustedStartIndex + 1, // Keep 1-indexed for consistency with LLM
                        endIndex: adjustedEndIndex,
                        firstWord: cleanedText.substring(adjustedStartIndex, adjustedStartIndex + c.firstWord.length),
                        lastWord: cleanedText.substring(adjustedEndIndex - c.lastWord.length, adjustedEndIndex),
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
                    .insert(cleanedChunks.map(c => ({
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
                    console.log(`Saved ${cleanedChunks.length} chunks to database`);
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

        const warnings = validateChunks(cleanedChunks, finalCleanedText);
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
        
        return result;
    } catch (error) {
        console.error('Clean and chunk error:', error);
        throw new Error(`Clean and chunk operation failed: ${error.message}`);
    }
}

async function generateMetadata(chunk) {
    return retryWithFallback(async (model) => {
        const response = await openai.chat.completions.create(
            createApiOptions(getModelForOperation('metadata'), [
                OPENAI_PROMPTS.metadata(),
                { role: "user", content: chunk.cleanedText }
            ])
        );
        console.log('Metadata operation used model:', response.model);
        return response.choices[0].message.content;
    });
}