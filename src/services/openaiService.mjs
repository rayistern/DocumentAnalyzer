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
                
                // Return a structure matching what cleanAndChunkDocument returns
                return {
                    metadata: metadata,
                    chunks: [],  // No chunks for metadata-only processing
                    warnings: [],
                    remainderText: ''
                };
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

function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = Math.min(
                    dp[i - 1][j - 1] + 1,  // substitution
                    dp[i - 1][j] + 1,      // deletion
                    dp[i][j - 1] + 1       // insertion
                );
            }
        }
    }
    return dp[m][n];
}

function isSimilarEnough(str1, str2, maxDistance = 2) {
    // For very short strings, be more strict
    if (str1.length < 5 || str2.length < 5) {
        maxDistance = 1;
    }
    
    // For longer strings, allow proportional difference
    const longerLength = Math.max(str1.length, str2.length);
    const maxProportionalDistance = Math.floor(longerLength * 0.2); // 20% difference allowed
    const effectiveMaxDistance = Math.min(maxDistance, maxProportionalDistance);
    
    const distance = levenshteinDistance(str1, str2);
    return {
        distance,
        isSimilar: distance <= effectiveMaxDistance,
        similarity: 1 - (distance / longerLength)
    };
}

/**
 * Removes specified text segments from the input text
 * 
 * This function is crucial for document cleaning. It takes the raw pre-chunk text
 * and removes segments identified by the LLM as unnecessary (like headers, footers,
 * footnotes, etc.).
 * 
 * IMPORTANT: This function should be applied ONLY to raw pre-chunk text, not to
 * remainder text from previous iterations. Remainder text is already cleaned
 * and should not be cleaned a second time.
 * 
 * @param {string} text - The raw pre-chunk text to clean
 * @param {Array} textToRemove - Array of segments to remove with position info
 * @returns {string} The cleaned text with specified segments removed
 */
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
            let found = false;

            // Adjust positions based on how much text we've removed so far
            const adjustedStart = item.startPosition - 1 - offset;
            const adjustedEnd = item.endPosition - offset;

            // Try exact position first with similarity check
            const exactText = cleanedText.substring(adjustedStart, adjustedEnd);
            const strippedExactText = stripDiacritics(exactText);
            const exactSimilarity = isSimilarEnough(strippedExactText, normalizedItemText);
            
            if (exactSimilarity.isSimilar) {
                found = true;
                cleanedText = cleanedText.substring(0, adjustedStart) + 
                            cleanedText.substring(adjustedEnd);
                offset += item.endPosition - item.startPosition;
                console.log(`Removed text at exact position: "${item.text}" (similarity: ${exactSimilarity.similarity.toFixed(2)})`);
            }

            // If exact position fails, search near the position
            if (!found) {
                const searchStart = Math.max(0, adjustedStart - tolerance);
                const searchEnd = Math.min(cleanedText.length, adjustedEnd + tolerance);
                const searchArea = cleanedText.substring(searchStart, searchEnd);
                const words = searchArea.split(/\s+/);
                
                // Try to find most similar substring
                let bestMatch = {
                    similarity: 0,
                    position: -1,
                    length: 0
                };

                for (let i = 0; i < words.length; i++) {
                    const candidateText = words.slice(i, i + 3).join(' '); // Try different word combinations
                    const strippedCandidate = stripDiacritics(candidateText);
                    const similarity = isSimilarEnough(strippedCandidate, normalizedItemText);
                    
                    if (similarity.isSimilar && similarity.similarity > bestMatch.similarity) {
                        const startPos = searchArea.indexOf(candidateText);
                        bestMatch = {
                            similarity: similarity.similarity,
                            position: startPos,
                            length: candidateText.length
                        };
                    }
                }

                if (bestMatch.position !== -1) {
                    found = true;
                    cleanedText = cleanedText.substring(0, searchStart + bestMatch.position) + 
                                cleanedText.substring(searchStart + bestMatch.position + bestMatch.length);
                    offset += bestMatch.length;
                    console.log(`Removed text by similarity search: "${item.text}" (similarity: ${bestMatch.similarity.toFixed(2)})`);
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

/**
 * Main document processing function that cleans and chunks a document
 * 
 * @param {string} content - Raw document content
 * @param {number} maxChunkLength - Maximum length for semantic chunks
 * @param {string} filepath - Path to the original file (for reference)
 * @param {string} overview - Optional document overview
 * @param {boolean} skipMetadata - Whether to skip metadata generation
 * @param {boolean} isContinuation - Whether this document continues from a previous one
 * @param {string} contentHash - Optional content hash
 * @returns {Object} Processing results including chunks and warnings
 */
async function cleanAndChunkDocument(content, maxChunkLength, filepath, overview = '', skipMetadata = false, isContinuation = false, contentHash = null) {
    console.log('\n=== Starting Document Processing ===');
    console.log(`Total document length: ${content.length} characters`);
    console.log(`Max chunk length: ${maxChunkLength} characters`);
    console.log('=====================================\n');
    
    // If this is a continuation, get the last chunk or remainder from previous document
    let previousText = '';
    
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
    console.log("REMAINDER-TRACK: Initial value is empty string");
    let finalCleanedText = '';  // Store the complete cleaned text

    // Constants for chunk boundary handling
    const CHUNK_END_OVERLAP = 100; // How much extra text to include at end of chunk for context overlap

    // Process each pre-chunk
    for (let i = 0; i < preChunks.length; i++) {
        console.log(`\nProcessing pre-chunk ${i + 1}/${preChunks.length}...`);
        
        /**
         * CRITICAL STEP 1: Get the raw pre-chunk text
         * 
         * Each pre-chunk is a raw piece of text from the document that needs to be:
         * 1. Cleaned first (to remove headers, footers, etc.)
         * 2. Then combined with any remainder from previous iteration
         */
        const chunk = preChunks[i];

        // Log current remainder before processing begins
        console.log(`Current remainder before processing (${remainderText.length} chars): "${remainderText.slice(0, Math.min(30, remainderText.length))}${remainderText.length > 30 ? '...' : ''}"`);
        
        // Save this pre-chunk to database (before any processing)
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

        /**
         * CRITICAL STEP 2: Clean the raw pre-chunk text
         * 
         * The cleaning step is applied ONLY to the raw pre-chunk text (chunk.text).
         * Remainder text is NOT included in cleaning because it was already cleaned
         * in a previous iteration.
         * 
         * The main purpose of cleaning is to remove headers, footers, footnotes, etc.
         * We don't want to clean the remainder text twice.
         */
        console.log('Cleaning raw pre-chunk text...');
        const cleanResponse = await openai.chat.completions.create(
            createApiOptions(getModelForOperation('clean'), [
                OPENAI_PROMPTS.cleanAndChunk.clean('', true), // Always set isIncomplete=true for continuations
                {
                    role: "user",
                    content: chunk.text
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
        
        /**
         * Adjust positions of textToRemove based on chunk start position
         * 
         * The LLM returns positions relative to the raw pre-chunk text it analyzed.
         * We need to adjust these positions to be relative to the original document.
         */
        if (cleanResult.textToRemove) {
            // Save the adjusted positions for document-level tracking
            // Add (chunk.startPosition - 1) to convert from chunk-relative to document-relative positions
            const adjustedTextToRemove = cleanResult.textToRemove.map(item => {
                const docStartPos = item.startPosition + chunk.startPosition - 1;
                const docEndPos = item.endPosition + chunk.startPosition - 1;
                console.log(`Position adjustment: chunk-relative (${item.startPosition}, ${item.endPosition}) -> doc-relative (${docStartPos}, ${docEndPos})`);
                return {
                ...item,
                    startPosition: docStartPos,
                    endPosition: docEndPos
                };
            });
            allTextToRemove = [...allTextToRemove, ...adjustedTextToRemove];
            
            // For cleaning the current chunk, we need positions relative to the chunk text
            // The LLM already returned positions relative to the chunk, so we use the original positions
        }
        
        /**
         * CRITICAL STEP 3: Process the clean result to get the cleaned pre-chunk text
         */
        let cleanedText = '';
        
        if (cleanResult.cleanedText) {
            // If the LLM returned cleanedText directly, use it
            cleanedText = cleanResult.cleanedText;
        } else if (cleanResult.textToRemove && cleanResult.textToRemove.length > 0) {
            // Apply the removal of identified problematic sections to get cleaned text
            // Use the original textToRemove positions as they're already relative to the chunk
            cleanedText = cleanText(chunk.text, cleanResult.textToRemove);
        } else {
            // If no textToRemove was identified, use the original text
            cleanedText = chunk.text;
        }
        
        /**
         * CRITICAL STEP 4: Combine cleaned pre-chunk with remainder
         * 
         * Now that we have the cleaned pre-chunk text, we combine it with any
         * remainder text from the previous iteration.
         * 
         * Note: The remainder text is already cleaned, so we don't clean it again.
         * We simply prepend it to our freshly cleaned text.
         */
        // TRACKING: Log remainder text details before any operations
        console.log(`\n=== REMAINDER TRACKING ===`);
        console.log(`[TRACK] remainderText before combining: ${remainderText.length} chars`);
        if (remainderText.length > 0) {
            // Check if it contains only whitespace
            if (remainderText.trim().length === 0) {
                console.log(`[TRACK] WARNING: Remainder contains only whitespace!`);
            }
            // Show the first few characters
            console.log(`[TRACK] First 20 chars: "${remainderText.substring(0, Math.min(20, remainderText.length))}"`);
        }
        
        console.log(`\n====== DETAILED TEXT FLOW LOGGING ======`);
        console.log(`\n1. REMAINDER TEXT (${remainderText.length} chars):`);
        // Check if there's actual content, not just whitespace
        const remainderHasContent = remainderText.trim().length > 0;
        
        if (remainderText.length > 0) {
            if (remainderHasContent) {
                console.log('----------------------------------------');
                // Print first 100 chars and last 100 chars if longer than 200 chars
                if (remainderText.length > 200) {
                    console.log(remainderText.substring(0, 100) + 
                            '\n... [middle content omitted] ...\n' + 
                            remainderText.substring(remainderText.length - 100));
                } else {
                    console.log(remainderText);
                }
                console.log('----------------------------------------');
            } else {
                console.log('[Remainder contains only whitespace]');
            }
        } else {
            console.log('[No remainder text]');
        }
        
        console.log(`\n2. CLEANED PRE-CHUNK (${cleanedText.length} chars):`);
        console.log('----------------------------------------');
        // Print first 100 chars and last 100 chars if longer than 200 chars
        if (cleanedText.length > 200) {
            console.log(cleanedText.substring(0, 100) + 
                       '\n... [middle content omitted] ...\n' + 
                       cleanedText.substring(cleanedText.length - 100));
        } else {
            console.log(cleanedText);
        }
        console.log('----------------------------------------');
        
        // Create the final cleaned text by prepending any remainder text to the cleaned pre-chunk text
        console.log("REMAINDER-TRACK: Before adding to cleanedText, length = " + remainderText.length + " chars");
        finalCleanedText = remainderText + cleanedText;
        console.log("REMAINDER-TRACK: Combined text length = " + finalCleanedText.length + " chars");
        
        // TRACKING: Check that the combined text starts with the remainder text if applicable
        if (remainderText.length > 0) {
            const combinedStartsWithRemainder = finalCleanedText.startsWith(remainderText);
            console.log(`AFTER COMBINING: Combined text starts with remainder: ${combinedStartsWithRemainder}`);
            
            if (!combinedStartsWithRemainder) {
                console.warn(`WARNING: Combined text does not start with remainder! This is unexpected.`);
                
                // Detailed comparison
                console.log(`Comparison of first few chars:`);
                for (let i = 0; i < Math.min(10, remainderText.length); i++) {
                    console.log(`Position ${i}: remainder="${remainderText.charAt(i)}" (${remainderText.charCodeAt(i)}), combined="${finalCleanedText.charAt(i)}" (${finalCleanedText.charCodeAt(i)})`);
                }
            }
        }

        // Add previous document context if this is a continuation and we're on the first chunk
        if (i === 0 && isContinuation && previousText) {
            console.log('Adding previous document context...');
            finalCleanedText = previousText + '\n\n' + finalCleanedText;
            
            // Log the text after adding previous context
            debugLogText("AFTER ADDING PREVIOUS CONTEXT", finalCleanedText, false);
        }

        console.log(`Preparing to chunk with total text length: ${finalCleanedText.length}`);

        /**
         * CRITICAL STEP 5: Send combined cleaned text to LLM for semantic chunking
         * 
         * Now we send the properly combined text (remainder + cleaned pre-chunk)
         * to the LLM to get semantically meaningful chunks.
         */
        console.log('Sending text for semantic chunking...');

        const messages = [
            OPENAI_PROMPTS.cleanAndChunk.chunk(maxChunkLength, !chunk.isComplete),
            {
                role: "user",
                content: finalCleanedText  // Use finalCleanedText here
            }
        ];
        
        console.log(`\n4. CHUNKING API CALL DETAILS:`);
        console.log('----------------------------------------');
        console.log(`Model: ${getModelForOperation('chunk')}`);
        console.log(`Max chunk length: ${maxChunkLength}`);
        console.log(`Is incomplete: ${!chunk.isComplete}`);
        console.log(`Text length: ${finalCleanedText.length} chars`);
        
        // More detailed logging for the start/end of text
        debugLogText("TEXT BEGINNING", finalCleanedText.substring(0, 50), false);
        debugLogText("TEXT ENDING", finalCleanedText.substring(finalCleanedText.length - 50), false);
        
        // Log whether the remainderText is included at the beginning
        if (remainderText.length > 0) {
            const firstFewCharsOfRemainder = remainderText.substring(0, Math.min(20, remainderText.length));
            const textIncludesRemainder = finalCleanedText.startsWith(firstFewCharsOfRemainder);
            console.log(`VERIFICATION - Text includes remainder: ${textIncludesRemainder ? 'YES' : 'NO'}`);
            
            if (!textIncludesRemainder) {
                console.warn(`WARNING: The text being sent for chunking may not include the remainder!`);
                console.log(`Debugging info:`);
                console.log(`- First chars of remainder: "${firstFewCharsOfRemainder}"`);
                console.log(`- First chars of final text: "${finalCleanedText.substring(0, Math.min(20, finalCleanedText.length))}"`);
                
                // Add hex representation for debugging invisible characters
                const remainderHex = Array.from(firstFewCharsOfRemainder)
                    .map(char => char.charCodeAt(0).toString(16).padStart(2, '0'))
                    .join(' ');
                const finalTextHex = Array.from(finalCleanedText.substring(0, Math.min(20, finalCleanedText.length)))
                    .map(char => char.charCodeAt(0).toString(16).padStart(2, '0'))
                    .join(' ');
                
                console.log(`- Remainder hex: ${remainderHex}`);
                console.log(`- Final text hex: ${finalTextHex}`);
                console.log(`- Remainder length: ${remainderText.length}`);
                console.log(`- Final text length: ${finalCleanedText.length}`);
                console.log(`- Remainder == start of finalCleanedText: ${remainderText === finalCleanedText.substring(0, remainderText.length)}`);
            }
        } else {
            console.log(`VERIFICATION - No remainder to include`);
        }
        console.log('----------------------------------------');
        
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
        } else {
            // If LLM didn't return chunks, treat entire cleaned text as remainder
            remainderText = finalCleanedText;
            console.log("[TRACK] UPDATED: remainderText = finalCleanedText (entire text) because no chunks returned");
            console.log("[TRACK] new remainderText length: " + remainderText.length + " chars");
            console.log('No chunks returned, entire text is remainder');
        }

        const chunkResult = parsedResponse;

        // Process chunks and determine remainder text for next iteration
        if (chunkResult.chunks && chunkResult.chunks.length > 0) {
            // Log pre-chunk information for debugging
            console.log('\nPre-chunk info:');
            console.log(`Start position: ${chunk.startPosition}`);
            console.log(`End position: ${chunk.endPosition}`);
            console.log(`Remainder length: ${remainderText.length}`);
            console.log(`Combined text length: ${finalCleanedText.length}`);
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
                            const safeStart = isStart ? previousChunkEnd : Math.max(nearPosition, previousChunkEnd + 1);
                            return safeStart;
                        }

                        const searchArea = text.substring(searchStart, searchEnd);
                        console.log(`- Search area length: ${searchArea.length}`);
                        
                        const searchAreaWords = searchArea.split(/\s+/);
                        console.log(`- Search area words: ${searchAreaWords.join(', ')}`);
                        
                        // Try to find the word in the search area
                        const wordIndex = searchAreaWords.findIndex(word => word.toLowerCase() === targetWord.toLowerCase());
                        if (wordIndex !== -1) {
                            return searchStart + wordIndex;
                        }

                        // If word not found, use safe position
                        const safePosition = isStart ? previousChunkEnd : Math.max(nearPosition, previousChunkEnd + 1);
                        return safePosition;
                    };

                    // Find the actual positions of first/last words within a tolerance range
                    const firstWordPosition = findWordPosition(finalCleanedText, c.firstWord, c.startIndex, true);
                    const lastWordPosition = findWordPosition(finalCleanedText, c.lastWord, c.endIndex, false);
                    
                    // Store the found positions
                    c.startIndex = firstWordPosition;
                    c.endIndex = lastWordPosition;
                    
                    // Debug output
                    console.log('\n=== Word position analysis ===');
                    console.log(`- First word: "${c.firstWord}"`);
                    console.log(`- Last word: "${c.lastWord}"`);
                    console.log(`- First word position: ${firstWordPosition}`);
                    console.log(`- Last word position: ${lastWordPosition}`);
                    
                    // Adjust positions using cumulative offset
                    c.startIndex += cumulativeOffset;
                    c.endIndex += cumulativeOffset;
                    
                    // Debug output
                    console.log('\n=== Position adjustment ===');
                    console.log(`- Original positions: ${c.startIndex}-${c.endIndex}`);
                    console.log(`- Adjusted positions: ${c.startIndex}-${c.endIndex}`);
                });

            // Calculate the new remainder text after all chunks have been processed
            // The remainder text is everything in finalCleanedText that comes after the last chunk's end
            const lastChunk = chunkResult.chunks[chunkResult.chunks.length - 1];
            if (lastChunk && !lastChunk.drop_remaining) {
                // Only update remainderText if the last processed chunk is valid
                // Get everything after the last chunk's end index
                remainderText = finalCleanedText.substring(lastChunk.endIndex);
                console.log(`[TRACK] UPDATED: remainderText = text after last chunk (${lastChunk.endIndex} to end)`);
                console.log(`[TRACK] new remainderText length: ${remainderText.length} chars`);
            }
        } else {
            // If LLM didn't return chunks, treat entire cleaned text as remainder
            remainderText = finalCleanedText;
            console.log("[TRACK] UPDATED: remainderText = finalCleanedText (entire text) because no chunks returned");
            console.log("[TRACK] new remainderText length: " + remainderText.length + " chars");
        }
    }

    // Store final remainder text in Supabase
    const { error: remainderError } = await supabase
        .from('document_remainders')
        .insert({
            document_id: document.id,
            remainder_text: remainderText,
            remainder_length: remainderText.length
        });

    if (remainderError) {
        console.error('Error storing remainder text:', remainderError);
    }

    // Store processed document in Supabase
    const { error: documentError } = await supabase
        .from('documents')
        .update({
            raw_llm_response: remainderText,
            status: 'processed',
            updated_at: new Date().toISOString()
        })
        .eq('id', document.id);

    if (documentError) {
        console.error('Error storing processed document:', documentError);
    }

    // Make sure chunkResult is defined before returning
    return {
        chunks: chunkResult?.chunks || [],
        remainderText: remainderText,
        warnings: chunkResult?.warnings || []
    };
}

function debugLogText(label, text, isRemainder) {
    console.log(`\n=== ${label} ===`);
    console.log('----------------------------------------');
    console.log(`${isRemainder ? 'Remainder' : 'Text'}:`);
    console.log('----------------------------------------');
    console.log(text);
    console.log('----------------------------------------');
}

/**
 * Process full metadata for a batch of documents.
 * This function doesn't clean or modify document content - it only adds metadata.
 */
export async function batchProcessFullMetadata(documentIds) {
    console.log(`Processing metadata for ${documentIds.length} documents`);
    
    for (const docId of documentIds) {
        try {
            console.log(`Processing document ${docId}`);
            
            // Fetch document content
            const { data: doc, error } = await supabase
                .from('documents')
                .select('*')
                .eq('id', docId)
                .single();
                
            if (error) {
                console.error(`Error fetching document ${docId}:`, error);
                continue;
            }
            
            // Use the same approach as the 'fullMetadata_only' case in processFile
            // Process metadata using the overview if available
            const metadataResponse = await openai.chat.completions.create(
                createApiOptions(getModelForOperation('fullMetadata'), [
                    OPENAI_PROMPTS.cleanAndChunk.fullMetadata(doc.overview || ''),
                    {
                        role: "user",
                        content: `${doc.overview ? doc.overview + '\n\n' : ''}${doc.content}`
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
            
            // Update the document with metadata ONLY (don't modify content)
            const { error: updateError } = await supabase
                .from('documents')
                .update({ 
                    raw_llm_response: metadataResponse.choices[0].message.content,
                    long_description: metadata.longDescription,
                    keywords: metadata.keywords,
                    questions_answered: metadata.questionsAnswered,
                    api_metadata: apiMetadata,
                    updated_at: new Date().toISOString()
                })
                .eq('id', docId);
                
            if (updateError) {
                console.error(`Error updating document ${docId}:`, updateError);
            } else {
                console.log(`Successfully processed metadata for document ${docId}`);
            }
        } catch (error) {
            console.error(`Error processing metadata for document ${docId}:`, error.message);
        }
    }
    
    return { success: true };
}