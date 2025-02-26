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

export async function processFile(content, type, filepath, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength, overview = '', skipMetadata = false, isContinuation = false, contentHash = null) {
    try {
        switch (type) {
            case 'sentiment':
                return await analyzeSentiment(content);
            case 'chunk':
                return await createChunks(content, maxChunkLength, filepath);
            case 'cleanAndChunk':
                return await cleanAndChunkDocument(content, maxChunkLength, filepath, overview, skipMetadata, isContinuation, contentHash);
            case 'fullMetadata_only':
                // Save initial document
                const document = await saveAnalysis(content, 'fullMetadata_only', { filepath });
                
                // Process metadata
                const metadataResponse = await openai.chat.completions.create(
                    createApiOptions(getModelForOperation('fullMetadata'), [
                        OPENAI_PROMPTS.cleanAndChunk.fullMetadata(overview),
                        {
                            role: "user",
                            content: `${overview ? overview + '\n\n' : ''}${content}`
                        }
                    ])
                );
                
                // Store raw response and metadata
                const cleanedResponse = removeMarkdownFormatting(metadataResponse.choices[0].message.content);
                const metadata = parseJsonResponse(cleanedResponse);
                
                // Create API metadata object
                const apiMetadata = {
                    model: metadataResponse.model,
                    created: metadataResponse.created,
                    usage: metadataResponse.usage,
                    system_fingerprint: metadataResponse.system_fingerprint,
                    response_ms: Date.now() - (metadataResponse.created * 1000) // Approximate response time
                };
                
                await supabase
                    .from('documents')
                    .update({ 
                        raw_llm_response: metadataResponse.choices[0].message.content,
                        long_description: metadata.longDescription,
                        keywords: metadata.keywords,
                        questions_answered: metadata.questionsAnswered,
                        api_metadata: apiMetadata,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', document.id);
                
                return metadata;
            default:
                return await summarizeContent(content);
        }
    } catch (error) {
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

function stripDiacritics(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function cleanText(text, textToRemove) {
    // Normalize quotation marks in the input text
    const normalizeQuotes = (str) => str.replace(/[""]/g, '"').replace(/['']/g, "'");
    let cleanedText = normalizeQuotes(text);
    const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;
    let offset = 0;  // Track how many characters we've removed

    if (textToRemove && Array.isArray(textToRemove)) {
        textToRemove.forEach(item => {
            // Normalize the text to remove and strip diacritics
            const normalizedItemText = stripDiacritics(normalizeQuotes(item.text));
            
            // IMPORTANT: First try the exact position the LLM gave us
            // Only fall back to searching if that fails
            let found = false;

            // Adjust positions based on how much text we've removed so far
            const adjustedStart = item.startPosition - 1 - offset;
            const adjustedEnd = item.endPosition - offset;

            // Try exact position first with diacritic-stripped comparison
            const exactText = stripDiacritics(cleanedText.substring(adjustedStart, adjustedEnd));
            if (exactText === normalizedItemText) {
                found = true;
                cleanedText = cleanedText.substring(0, adjustedStart) + 
                            cleanedText.substring(adjustedEnd);
                offset += item.endPosition - item.startPosition;
                console.log(`Removed text at exact position: "${item.text}"`);
            }

            // If exact position fails, search near the position
            if (!found) {
                const searchStart = Math.max(0, adjustedStart - tolerance);
                const searchEnd = Math.min(cleanedText.length, adjustedEnd + tolerance);
                const searchArea = cleanedText.substring(searchStart, searchEnd);
                const strippedSearchArea = stripDiacritics(searchArea);
                
                const textPos = strippedSearchArea.indexOf(normalizedItemText);
                if (textPos !== -1) {
                    found = true;
                    const originalLength = searchArea.substring(textPos, textPos + item.text.length).length;
                    cleanedText = cleanedText.substring(0, searchStart + textPos) + 
                                cleanedText.substring(searchStart + textPos + originalLength);
                    offset += originalLength;
                    console.log(`Removed text by position-guided search: "${item.text}"`);
                }
            }

            // If position-based approaches fail, try context matching
            if (!found && item.contextBefore && item.contextAfter) {
                const pattern = escapeRegExp(stripDiacritics(item.contextBefore + item.text + item.contextAfter));
                const strippedCleanedText = stripDiacritics(cleanedText);
                const match = strippedCleanedText.match(new RegExp(pattern));
                if (match) {
                    found = true;
                    const matchStart = match.index + stripDiacritics(item.contextBefore).length;
                    const originalLength = cleanedText.substring(matchStart, matchStart + item.text.length).length;
                    cleanedText = cleanedText.substring(0, matchStart) + 
                                cleanedText.substring(matchStart + originalLength);
                    offset += originalLength;
                    console.log(`Removed text by context match: "${item.text}"`);
                } else {
                    // Try with just before or after context
                    const beforePattern = escapeRegExp(stripDiacritics(item.contextBefore + item.text));
                    const afterPattern = escapeRegExp(stripDiacritics(item.text + item.contextAfter));
                    
                    const beforeMatch = strippedCleanedText.match(new RegExp(beforePattern));
                    const afterMatch = strippedCleanedText.match(new RegExp(afterPattern));
                    
                    if (beforeMatch) {
                        found = true;
                        const matchStart = beforeMatch.index + stripDiacritics(item.contextBefore).length;
                        const originalLength = cleanedText.substring(matchStart, matchStart + item.text.length).length;
                        cleanedText = cleanedText.substring(0, matchStart) + 
                                    cleanedText.substring(matchStart + originalLength);
                        offset += originalLength;
                        console.log(`Removed text by before-context match: "${item.text}"`);
                    } else if (afterMatch) {
                        found = true;
                        const matchStart = afterMatch.index;
                        const originalLength = cleanedText.substring(matchStart, matchStart + item.text.length).length;
                        cleanedText = cleanedText.substring(0, matchStart) + 
                                    cleanedText.substring(matchStart + originalLength);
                        offset += originalLength;
                        console.log(`Removed text by after-context match: "${item.text}"`);
                    }
                }
            }

            // Last resort: if all else fails and text appears exactly once
            if (!found) {
                const strippedCleanedText = stripDiacritics(cleanedText);
                const matches = strippedCleanedText.match(new RegExp(escapeRegExp(normalizedItemText), 'g'));
                if (matches && matches.length === 1) {
                    const matchStart = strippedCleanedText.indexOf(normalizedItemText);
                    const originalLength = cleanedText.substring(matchStart, matchStart + item.text.length).length;
                    cleanedText = cleanedText.substring(0, matchStart) + 
                                cleanedText.substring(matchStart + originalLength);
                    offset += originalLength;
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
    // First try to extract content between backticks if present
    const backtickMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (backtickMatch) {
        return backtickMatch[1].trim();
    }
    
    // If no backticks, try to find the first { and last }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return jsonMatch[0];
    }
    
    // If neither found, return original text
    return text;
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

        result.warnings = validateChunks(result.chunks, result.textToRemove.length, text.length);
        
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

function validateChunks(chunks, effectiveLength, originalLength) {
    const documentWarnings = [];
    console.log('\nValidating chunks against text length:', originalLength);
    
    chunks.forEach((chunk, index) => {
        const chunkWarnings = [];
        
        if (index > 0) {
            const gap = chunk.startIndex - chunks[index - 1].endIndex - 1;
            if (gap > 0) {
                chunkWarnings.push(`Gap of ${gap} characters detected`);
            }
        }

        // Check if chunk end index exceeds text length
        if (chunk.endIndex > originalLength) {
            chunkWarnings.push(`Chunk end index (${chunk.endIndex}) exceeds text length (${originalLength})`);
            // Signal to stop processing further chunks
            chunk.drop_remaining = true;
            return;
        }

        // Use the chunk's own cleanedText for sentence break validation
        const endsWithPeriod = chunk.cleanedText.trim().match(/[.!?]$/);

        if (!endsWithPeriod) {
            chunkWarnings.push(`Does not end with a sentence break`);
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

    if (chunks.length > 0 && chunks[chunks.length - 1].endIndex < originalLength) {
        const remaining = originalLength - chunks[chunks.length - 1].endIndex;
        documentWarnings.push(`Unprocessed text remaining: ${remaining} characters`);
    }

    return documentWarnings;
}

function findCompleteBoundary(text, position, word) {
    // Normalize quotation marks in both the search text and word
    const normalizeQuotes = (str) => str.replace(/[""]/g, '"').replace(/['']/g, "'");
    
    // Look for the word within tolerance range
    const start = Math.max(0, position - tolerance);
    const end = Math.min(text.length, position + tolerance);
    const searchText = normalizeQuotes(text.substring(start, end));
    const normalizedWord = normalizeQuotes(word);
    
    const wordIndex = searchText.indexOf(normalizedWord);
    if (wordIndex !== -1) {
        return start + wordIndex;
    }
    
    return position;
}

async function cleanAndChunkDocument(content, maxChunkLength, filepath, overview = '', skipMetadata = false, isContinuation = false, contentHash = null) {
    console.log('\n=== Starting Document Processing ===');
    console.log(`Total document length: ${content.length} characters`);
    console.log(`Max chunk length: ${maxChunkLength} characters`);
    console.log('=====================================\n');
    
    // If this is a continuation, get the last chunk or remainder from previous document
    let previousText = '';
    let totalEffectiveLength = 0;  // Initialize here
    
    if (isContinuation) {
        console.log('Getting previous document context...');
        const { data: lastDoc, error: lastDocError } = await supabase
            .from('documents')
            .select('id')
            .order('created_at', { ascending: false })
            .limit(1);
            
        if (!lastDocError && lastDoc?.length > 0) {
            // First try to get remainder
            const { data: remainder, error: remainderError } = await supabase
                .from('document_remainders')
                .select('remainder_text')
                .eq('document_id', lastDoc[0].id)
                .single();
                
            if (!remainderError && remainder?.remainder_text) {
                previousText = remainder.remainder_text;
                console.log('Using remainder from previous document');
            } else {
                // If no remainder, get last chunk
                const { data: lastChunk, error: chunkError } = await supabase
                    .from('chunks')
                    .select('cleaned_text')
                    .eq('document_id', lastDoc[0].id)
                    .order('end_index', { ascending: false })
                    .limit(1)
                    .single();
                    
                if (!chunkError && lastChunk) {
                    previousText = lastChunk.cleaned_text;
                    console.log('Using last chunk from previous document');
                }
            }
        }
    }
    
    // Save initial document with the raw content hash
    const document = await saveAnalysis(content, skipMetadata ? 'cleanAndChunk' : 'fullMetadata_only', { 
        filepath,
        content_hash: contentHash
    });
    console.log('Saved original document with ID:', document.id);

    // Create new session for this document
    const currentSession = {
        messages: [],
        documentId: document.id
    };

    // Pre-chunk the text
    const preChunks = preChunkText(content, OPENAI_SETTINGS.preChunkSize);
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
                OPENAI_PROMPTS.cleanAndChunk.clean('', true), // Always set isIncomplete=true for continuations
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

        // Then combine with previous text if needed (only on first iteration)
        let finalCleanedText = cleanedText;

        // If this is the first chunk and we have previous text, prepend it before chunking
        if (i === 0 && previousText) {
            finalCleanedText = previousText + '\n' + cleanedText;
            console.log('Prepended previous document context');
        }

        // If we have remainder text from previous iteration, prepend it
        if (remainderText) {
            finalCleanedText = remainderText + '\n' + finalCleanedText;
            console.log('Prepended remainder text from previous iteration');
        }

        totalEffectiveLength = finalCleanedText.length;  // Update after cleaning and combining

        // Send finalCleanedText to LLM for chunking
        console.log('\nText being sent to LLM for chunking:');
        console.log('----------------------------------------');
        console.log(finalCleanedText);
        console.log('----------------------------------------\n');

        const messages = [
            OPENAI_PROMPTS.cleanAndChunk.chunk(maxChunkLength, !chunk.isComplete),
            {
                role: "user",
                content: finalCleanedText  // Use finalCleanedText here
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
            console.log(`Effective text length: ${finalCleanedText.length}`);  // Add this log

            let cumulativeOffset = 0;  // Reset for each chunk processing
            let previousAdjustedEnd = 0;  // Reset for each chunk processing

            chunkResult.chunks = chunkResult.chunks
                .map((c, index) => {
                    // Check if we need to force start after previous chunk
                    let startIndex = c.startIndex;
                    let endIndex = c.endIndex;
                    
                    if (index > 0) {
                        const gap = startIndex - (previousAdjustedEnd + 1);
                        if (gap < 0) {
                            // Handle negative gap (chunk trying to start before previous ended)
                            startIndex = Math.min(previousAdjustedEnd + 1, finalCleanedText.length);
                            console.log(`Negative gap detected (${gap}). Forcing chunk to start at ${startIndex}`);
                        } else if (gap > OPENAI_SETTINGS.gapConfig.maxTolerance) {
                            // Handle too large positive gap
                            startIndex = Math.min(previousAdjustedEnd + 1, finalCleanedText.length);
                            console.log(`Gap of ${gap} exceeds tolerance. Forcing chunk to start at ${startIndex}`);
                        }
                    }
                    
                    // Use effectiveTextLength for validation
                    if (startIndex >= finalCleanedText.length) {
                        console.log(`Start index ${startIndex} exceeds text length ${finalCleanedText.length}. Stopping chunk processing.`);
                        return { drop_remaining: true };
                    }

                    // Ensure end index doesn't exceed text length and is after start
                    if (endIndex > finalCleanedText.length) {
                        console.log(`End index ${endIndex} exceeds text length ${finalCleanedText.length}. Adjusting to text end.`);
                        endIndex = finalCleanedText.length;
                        // Signal to stop processing further chunks after this one
                        c.drop_remaining = true;
                    }

                    if (endIndex <= startIndex) {
                        console.log(`End index ${endIndex} is not after start index ${startIndex}. Stopping chunk processing.`);
                        return { drop_remaining: true };
                    }
                    
                    // Store this chunk's adjusted end for next iteration
                    previousAdjustedEnd = endIndex;
                    
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
                        // Ensure nearPosition is within text bounds
                        console.log(`\nfindWordPosition input values:`);
                        console.log(`- Original nearPosition: ${nearPosition}`);
                        console.log(`- Text length: ${text.length}`);
                        console.log(`- Previous chunk end: ${previousChunkEnd}`);
                        
                        const origNearPosition = nearPosition;  // Store original for logging
                        nearPosition = Math.min(Math.max(0, nearPosition), text.length);
                        if (nearPosition !== origNearPosition) {
                            console.log(`- nearPosition adjusted to: ${nearPosition} (was: ${origNearPosition})`);
                        }
                        
                        // For start positions, search from previous chunk end
                        // For end positions, search from current chunk start
                        const searchStart = Math.max(0, nearPosition - tolerance);
                        const searchEnd = Math.min(text.length, nearPosition + tolerance);
                        console.log(`- Search range: ${searchStart}-${searchEnd}`);
                        
                        // If search bounds are invalid, use safe position
                        if (searchStart >= searchEnd) {
                            const result = isStart ? previousChunkEnd : Math.max(nearPosition, previousChunkEnd + 1);
                            console.log(`- Invalid search bounds (${searchStart} >= ${searchEnd})`);
                            console.log(`- Using fallback position: ${result}`);
                            return result;
                        }
                        
                        const searchArea = text.substring(searchStart, searchEnd);
                        console.log(`- Search area text: "${searchArea}"`);
                        console.log(`- Search area length: ${searchArea.length}`);
                        
                        // Try exact match first
                        const exactIndex = searchArea.indexOf(targetWord);
                        if (exactIndex !== -1) {
                            const foundPosition = searchStart + exactIndex;
                            console.log(`Found exact match "${targetWord}" at position ${foundPosition}`);
                            return foundPosition;
                        }
                        console.log(`- No exact match found`);

                        // Try searching in a wider area if first search failed
                        const widerStart = Math.max(0, nearPosition - tolerance * 2);
                        const widerEnd = Math.min(text.length, nearPosition + tolerance * 2);
                        const widerArea = text.substring(widerStart, widerEnd);
                        console.log(`\nTrying wider search: ${widerStart}-${widerEnd}`);
                        console.log(`- Wider area text: "${widerArea}"`);
                        
                        const words = widerArea.split(/\s+/);
                        console.log(`- Words in search area: ${JSON.stringify(words)}`);
                        let bestMatch = null;
                        let bestMatchIndex = -1;
                        let bestMatchDifference = Infinity;

                        for (let i = 0; i < words.length; i++) {
                            const word = words[i];
                            if (Math.abs(word.length - targetWord.length) <= 1) {
                                let differences = 0;
                                const minLength = Math.min(word.length, targetWord.length);
                                for (let j = 0; j < minLength; j++) {
                                    if (word[j] !== targetWord[j]) differences++;
                                    if (differences > 1) break;
                                }
                                
                                if (differences <= 1 && differences < bestMatchDifference) {
                                    bestMatch = word;
                                    bestMatchDifference = differences;
                                    const wordPos = widerArea.indexOf(word);
                                    if (wordPos !== -1) {
                                        bestMatchIndex = widerStart + wordPos;
                                    }
                                }
                            }
                        }

                        if (bestMatchIndex !== -1) {
                            console.log(`Found fuzzy match "${bestMatch}" for target "${targetWord}" at position ${bestMatchIndex}`);
                            return bestMatchIndex;
                        }

                        // If no match found, use suggested position but ensure it's valid
                        console.log(`No match found for "${targetWord}" near ${nearPosition}`);
                        if (isStart) {
                            // For start positions, use the suggested position but ensure it's after previous chunk
                            const safeStart = Math.max(nearPosition, previousChunkEnd);
                            console.log(`Using safe start position: ${safeStart}`);
                            return safeStart;
                        } else {
                            // For end positions:
                            // 1. Calculate intended length from original near position
                            // 2. Ensure we're after the start position
                            // 3. Stay within text bounds
                            // 4. Never collapse to start
                            const intendedLength = nearPosition - previousChunkEnd;
                            console.log(`Intended length from near position: ${intendedLength}`);
                            
                            // Ensure we're at least one character after start and preserve some length
                            const minLength = Math.max(50, intendedLength);  // At least 50 chars or intended length
                            const safeEnd = Math.min(
                                text.length,
                                Math.max(previousChunkEnd + minLength, nearPosition)
                            );
                            
                            console.log(`Using safe end position: ${safeEnd} (minLength: ${minLength})`);
                            return safeEnd;
                        }
                    };

                    // Find where the LLM's suggested words actually appear in the text
                    // For the start position, we can use the previous chunk's end as fallback
                    const previousChunkEnd = index > 0 ? chunkResult.chunks[index - 1].adjustedEndIndex : 0;
                    const adjustedStartIndex = findWordPosition(finalCleanedText, c.firstWord, suggestedStartIndex, true, previousChunkEnd);
                    
                    // For the end position, we'll allow overlap beyond the LLM's suggestion
                    const adjustedEndIndex = findWordPosition(finalCleanedText, c.lastWord, suggestedEndIndex, false, adjustedStartIndex);
                    
                    // When calculating offsets, we need to track how far actual word positions deviate
                    // from where the LLM expected them to be
                    const newOffset = adjustedEndIndex - c.endIndex;  // Compare to LLM's original position, not bounds-checked endIndex
                    cumulativeOffset = newOffset;  // Set new offset directly, don't accumulate
                    
                    console.log(`Position adjustments:`);
                    console.log(`- Original LLM positions: ${c.startIndex}-${c.endIndex}`);
                    console.log(`- Suggested positions: ${suggestedStartIndex}-${suggestedEndIndex}`);
                    console.log(`- Final positions: ${adjustedStartIndex + 1}-${adjustedEndIndex}`);
                    console.log(`- New offset: ${newOffset}`);

                    // Extract the text between our found positions
                    const extractedText = finalCleanedText.substring(adjustedStartIndex, adjustedEndIndex);
                    
                    // Find where the period actually is for validation
                    const periodIndex = finalCleanedText.indexOf('.', adjustedStartIndex);
                    console.log('\nChunk Position Analysis:');
                    console.log(`Chunk ${index + 1}:`);
                    console.log(`- Text length: ${finalCleanedText.length}`);
                    console.log(`- Original LLM positions: ${c.startIndex}-${c.endIndex}`);
                    console.log(`- Final positions: ${adjustedStartIndex + 1}-${adjustedEndIndex}`);
                    console.log(`- Chunk size: ${adjustedEndIndex - adjustedStartIndex} characters`);
                    
                    // Check if our position adjustments stayed within tolerance
                    const positionDifference = Math.abs(adjustedEndIndex - c.endIndex);  // Compare to original LLM position
                    const withinTolerance = positionDifference <= tolerance;
                    
                    // Get the actual words we found at our chosen positions for validation
                    const actualFirstWord = finalCleanedText.substring(adjustedStartIndex).split(/\s+/)[0];
                    const actualLastWord = finalCleanedText.substring(0, adjustedEndIndex).split(/\s+/).pop();
                    
                    console.log('\nBoundary Words:');
                    console.log(`- First: "${actualFirstWord}" (expected: "${c.firstWord}")`);
                    console.log(`- Last: "${actualLastWord}" (expected: "${c.lastWord}")`);
                    console.log(`- Position difference: ${positionDifference} chars`);
                    
                    return {
                        startIndex: adjustedStartIndex + 1,  // Keep 1-indexed for consistency with LLM
                        endIndex: adjustedEndIndex + 1,      // Keep 1-indexed for consistency with LLM
                        firstWord: finalCleanedText.substring(adjustedStartIndex, adjustedStartIndex + c.firstWord.length),
                        lastWord: finalCleanedText.substring(adjustedEndIndex - c.lastWord.length, adjustedEndIndex),
                        cleanedText: extractedText,
                        original_text: chunk.text,
                        first_word_match: actualFirstWord === c.firstWord,
                        last_word_match: actualLastWord === c.lastWord,
                        within_tolerance: withinTolerance,
                        position_difference: positionDifference
                    };
                })
                .reduce((acc, chunk) => {
                    // If we hit a drop_remaining signal, stop processing
                    if (chunk.drop_remaining) {
                        return acc;
                    }
                    // Otherwise keep accumulating valid chunks
                    return [...acc, chunk];
                }, []);

            // Get remainder text for next iteration
            // This is text after the last chunk that will be combined with the next pre-chunk
            const lastChunk = chunkResult.chunks[chunkResult.chunks.length - 1];
            remainderText = finalCleanedText.substring(lastChunk.endIndex);
            console.log(`\nRemainder info:`);
            console.log(`- Length: ${remainderText.length} characters`);
            if (remainderText.length > 0) {
                console.log(`- First few words: "${remainderText.slice(0, 20)}..."`);
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
                    created_at: new Date().toISOString()
                })));

            if (chunksError) {
                console.error('Error saving chunks:', chunksError);
            } else {
                console.log(`Saved ${cleanedChunks.length} chunks to database`);
            }
        } else {
            // If LLM didn't return chunks, treat entire cleaned text as remainder
            remainderText = finalCleanedText;
            console.log('No chunks returned, entire text is remainder');
        }
    }

    // Handle final remainder if any
    if (remainderText.trim()) {
        console.log(`Processing final remainder of length ${remainderText.length}`);
        totalEffectiveLength += remainderText.length;  // Add remainder to total length
        cleanedChunks.push({
            startIndex: content.length - remainderText.length + 1,
            endIndex: content.length,
            cleanedText: remainderText,
            firstWord: remainderText.trim().split(/\s+/)[0],
            lastWord: remainderText.trim().split(/\s+/).pop()
        });
    }

    const warnings = validateChunks(cleanedChunks, totalEffectiveLength, finalCleanedText.length);
    console.log('Validation warnings:', warnings);

    const result = {
        textToRemove: allTextToRemove,
        chunks: cleanedChunks,
        warnings
    };

    // Store chunks in database
    console.log('Storing results in database...');
    await saveAnalysis(content, 'chunk', { 
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
            const isLastChunk = i === cleanedChunks.length - 1;
            
            // Skip metadata for last chunk if this is a continuation and there's no remainder
            if (isLastChunk && isContinuation && !remainderText.trim()) {
                // Check if this is the last file in the queue
                const { data: nextFile, error: fileError } = await supabase
                    .from('document_sources')
                    .select('id')
                    .gt('created_at', new Date().toISOString())
                    .limit(1);
                
                if (!fileError && nextFile?.length > 0) {
                    console.log('Skipping metadata for last chunk as this is a continuation');
                    continue;
                }
            }

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
    
    // Store the remainder for potential next document
    if (remainderText.trim()) {
        console.log(`Remainder text (${remainderText.length} chars) will be used in next iteration`);
        if (remainderText.length > 0) {
            console.log(`First few words: "${remainderText.slice(0, 20)}..."`);
        }
    }
    
    return result;
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

export async function batchProcessFullMetadata(documentIds) {
    for (const docId of documentIds) {
        try {
            // Get document from database
            const { data: document, error: docError } = await supabase
                .from('documents')
                .select('*')
                .eq('id', docId)
                .single();

            if (docError) {
                console.error(`Error fetching document ${docId}:`, docError);
                continue;
            }

            console.log(`Processing metadata for document ${docId}...`);
            
            try {
                const metadataResponse = await openai.chat.completions.create(
                    createApiOptions(getModelForOperation('fullMetadata'), [
                        OPENAI_PROMPTS.cleanAndChunk.fullMetadata(),
                        {
                            role: "user",
                            content: document.content
                        }
                    ])
                );
                
                // Store raw response
                const { error: rawError } = await supabase
                    .from('documents')
                    .update({ 
                        raw_llm_response: metadataResponse.choices[0].message.content,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', docId);

                if (rawError) {
                    console.error(`Error storing raw response for document ${docId}:`, rawError);
                    continue;
                }
                
                // Parse and store metadata
                const cleanedResponse = removeMarkdownFormatting(metadataResponse.choices[0].message.content);
                const metadata = parseJsonResponse(cleanedResponse);
                
                const { error: metadataError } = await supabase
                    .from('documents')
                    .update({ 
                        long_description: metadata.longDescription,
                        keywords: metadata.keywords,
                        questions_answered: metadata.questionsAnswered,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', docId);

                if (metadataError) {
                    console.error(`Error saving metadata for document ${docId}:`, metadataError);
                } else {
                    // Update document source status to processed
                    const { error: statusError } = await supabase
                        .from('document_sources')
                        .update({ 
                            status: 'processed',
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', document.document_source_id);

                    if (statusError) {
                        console.error(`Error updating status for document ${docId}:`, statusError);
                    } else {
                        console.log(`Successfully processed metadata for document ${docId}`);
                    }
                }
            } catch (error) {
                console.error(`Error in metadata generation for document ${docId}:`, error);
            }
        } catch (error) {
            console.error(`Error processing document ${docId}:`, error);
        }
    }
}