import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';
import { logLLMResponse } from './llmLoggingService.mjs';
import { saveAnalysis, saveCleanedDocument, saveChunkMetadata } from './supabaseService.mjs';
import { preChunkText, shouldUseSimplifiedPrompt } from './preChunkingService.mjs';
import dotenv from 'dotenv'
import { supabase } from './supabaseService.mjs';
import { retryWithFallback, validateGap } from './errorHandlingService.mjs';
import { parseJsonResponse } from '../utils/jsonUtils.mjs';
import { setupProcessTimeout } from '../config.mjs';
import { extractChunkBySnippets_V2 } from '../utils/chunkingUtils.mjs'; // NEW
import crypto from 'crypto';
import { appendEndSnippetIfMissing } from '../utils/chunkFixUtils.mjs'
import { shiftStartIndexByPrevSnippet } from '../utils/chunkFixUtils.mjs'

dotenv.config()

// Set up the global timeout for all processes
setupProcessTimeout();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;

function supportsJsonFormat(model) {
    return OPENAI_SETTINGS.modelConfig.jsonFormatSupported.some(prefix => model.startsWith(prefix));
}

function createApiOptions(model, messages) {
    // Combine consecutive user messages to save tokens
    if (messages.length > 1) {
        const combinedMessages = [];
        let currentUserContent = null;
        
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            
            if (msg.role === "user") {
                if (currentUserContent === null) {
                    currentUserContent = msg.content;
                } else {
                    // Combine with previous user message
                    currentUserContent += "\n\n" + msg.content;
                }
            } else {
                // If we have pending user content, add it first
                if (currentUserContent !== null) {
                    combinedMessages.push({
                        role: "user",
                        content: currentUserContent
                    });
                    currentUserContent = null;
                }
                
                // Add non-user message
                combinedMessages.push(msg);
            }
        }
        
        // Add any remaining user content
        if (currentUserContent !== null) {
            combinedMessages.push({
                role: "user",
                content: currentUserContent
            });
        }
        
        messages = combinedMessages;
    }

    const options = {
        model,
        messages
    };
    
    // ⬇️ new debug output
    if (process.env.LOG_PROMPTS === 'true') {
        console.log('\n========= LLM PROMPT =========');
        console.log(`Model: ${model}`);
        console.log(JSON.stringify(messages, null, 2));
        console.log('==============================\n');
    }
    
    // Only add response_format for models that explicitly support it
    if (model.startsWith('gpt-4o')) {
        options.response_format = { type: "json_object" };
    }
    
    return options;
}

function getModelForOperation(operation) {
    return OPENAI_SETTINGS.modelConfig.operations[operation] || OPENAI_SETTINGS.model;
}

/**
 * Processes a file based on the specified type, handling different workflows
 * 
 * IMPORTANT PARAMETER AND TEXT FLOW NOTES:
 * 
 * This service has multiple document processing flows with different orders of operations:
 * 
 * 1. cleanAndChunkDocument (preferred method):
 *    a. Pre-chunks text into manageable pieces
 *    b. Cleans each pre-chunk (removes headers, footers)
 *    c. Prepends remainder text from previous iteration
 *    d. Creates finalCleanedText = remainderText + cleanedText
 *    e. Sends finalCleanedText to LLM for semantic chunking
 *    f. Extracts chunks using indices relative to finalCleanedText
 *    g. Processes remainder for next iteration
 * 
 * 2. createChunks (alternative method, may have issues):
 *    a. Sends raw uncleaned text to LLM
 *    b. LLM returns chunk indices relative to raw text
 *    c. Cleans each chunk individually after extraction
 *    d. May result in suboptimal chunks since cleaning happens after boundary detection
 * 
 * PARAMETER NAMING CONSISTENCY:
 * - content: Raw document content from source
 * - chunk.text: Raw text of a pre-chunk
 * - cleanedText: Text after removing headers/footers
 * - finalCleanedText: remainderText + cleanedText (what's sent to LLM)
 * - remainderText: Text saved from previous iteration
 * 
 * JSON PARSING PARAMETERS:
 * - Always use parseJsonResponse(response, null, 'schemaType') when no text extraction needed
 * - For chunk extraction, pass the exact text sent to LLM: parseJsonResponse(response, finalCleanedText, 'chunk')
 * 
 * @param {string} content - Raw document content
 * @param {string} type - Processing type ('cleanAndChunk', 'chunk', 'sentiment', etc.)
 * @param {string} filepath - Path to original file
 * @param {number} maxChunkLength - Maximum length for each chunk
 * @param {string} overview - Optional overview text to include
 * @param {boolean} skipMetadata - Whether to skip metadata generation
 * @param {boolean} isContinuation - Whether document continues from a previous one
 * @param {string|null} groupNumber - Optional group number
 * @param {string|null} previousDocumentId - ID of previous document (deprecated)
 * @param {string|null} inMemoryRemainderText - Remainder text from previous document
 * @returns {Object} Processing results based on type
 */
export async function processFile(
  content,
  type,
  filepath,
  maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength,
  overview = '',
  skipMetadata = false,
  isContinuation = false,
  groupNumber = null,
  previousDocumentId = null,
  inMemoryRemainderText = null,
  lastFileInBatch = false,          // ← NEW
) {
    try {
        // Add a check for the group number to prevent processing files with unexpected group numbers
        if (groupNumber && groupNumber.includes('igrosgpt4.5-1a') && !groupNumber.includes('test')) {
            console.log(`\n[${new Date().toISOString()}] ⚠️ WARNING: Detected potential issue with group number: ${groupNumber}`);
            console.log(`[${new Date().toISOString()}] This group number matches the pattern of unexpected entries.`);
            console.log(`[${new Date().toISOString()}] Please check if this is the intended group number.`);
            
            // Log a stack trace to see where this call is coming from
            console.log(`[${new Date().toISOString()}] Call stack:`);
            console.log(new Error().stack);
        }
        
        switch (type) {
            case 'sentiment':
                return await analyzeSentiment(content);
            case 'chunk':
                return await createChunks(content, maxChunkLength, filepath);
            case 'cleanAndChunk':
                return await cleanAndChunkDocument(
                    content,
                    maxChunkLength,
                    filepath,
                    overview,
                    skipMetadata,
                    isContinuation,
                    groupNumber,
                    previousDocumentId,
                    inMemoryRemainderText,
                    lastFileInBatch          // pass through
                );
            case 'fullMetadata_only':
                // Save initial document
                console.log(`\n[${new Date().toISOString()}] 🔍 FULL METADATA ONLY PROCESSING START: ${filepath}`);
                console.log(`[${new Date().toISOString()}] Group: ${groupNumber || 'none'}`);
                
                const document = await saveAnalysis(content, 'fullMetadata_only', { 
                    filepath,
                    groupNumber  // Pass groupNumber separately, not as content_hash
                });
                
                console.log(`[${new Date().toISOString()}] ✅ Initial document saved with ID: ${document.id}`);
                
                // Process metadata
                console.log(`[${new Date().toISOString()}] 🔄 Calling OpenAI API for metadata...`);
                const metadataResponse = await openai.chat.completions.create(
                    createApiOptions(getModelForOperation('fullMetadata'), [
                        OPENAI_PROMPTS.cleanAndChunk.fullMetadata(overview),
                        {
                            role: "user",
                            content: `${overview ? overview + '\n\n' : ''}${content}`
                        }
                    ])
                );
                
                console.log(`[${new Date().toISOString()}] ✅ Received OpenAI response for metadata`);
                
                // Add detailed token usage logging
                console.log(`[${new Date().toISOString()}] 📊 TOKEN USAGE:`, {
                    prompt_tokens: metadataResponse.usage?.prompt_tokens || 'N/A',
                    completion_tokens: metadataResponse.usage?.completion_tokens || 'N/A',
                    total_tokens: metadataResponse.usage?.total_tokens || 'N/A',
                    reasoning_tokens: metadataResponse.usage?.completion_tokens_details?.reasoning_tokens || 'N/A',
                    cached_tokens: metadataResponse.usage?.prompt_tokens_details?.cached_tokens || 'N/A', 
                    raw_usage_object: JSON.stringify(metadataResponse.usage)
                });
                
                // Store raw response and metadata
                const cleanedResponse = removeMarkdownFormatting(metadataResponse.choices[0].message.content);
                const metadata = parseJsonResponse(cleanedResponse, null, 'fullMetadata');
                
                // Create API metadata object
                const apiMetadata = {
                    model: metadataResponse.model,
                    created: metadataResponse.created,
                    usage: metadataResponse.usage,
                    system_fingerprint: metadataResponse.system_fingerprint,
                    response_ms: Date.now() - (metadataResponse.created * 1000) // Approximate response time
                };
                
                // Add detailed logging for document update
                const updateTimestamp = new Date().toISOString();
                console.log(`\n[${updateTimestamp}] 🔄 UPDATING document in fullMetadata_only case`);
                console.log(`[${updateTimestamp}] Document ID: ${document.id}`);
                console.log(`[${updateTimestamp}] Filepath: ${filepath}`);
                console.log(`[${updateTimestamp}] Group: ${groupNumber || 'none'}`);
                
                try {
                    const { error: updateError } = await supabase
                        .from('documents')
                        .update({ 
                            raw_llm_response: metadataResponse.choices[0].message.content,
                            long_description: metadata.longDescription,
                            keywords: metadata.keywords,
                            questions_answered: metadata.questionsAnswered,
                            category: metadata.category,
                            novel_approaches: metadata.novel_approaches,
                            api_metadata: apiMetadata,
                            status: 'processed', // Add status update to mark as processed
                            updated_at: new Date().toISOString(),
                            input_tokens: metadataResponse.usage?.prompt_tokens || null,
                            output_tokens: metadataResponse.usage?.completion_tokens || null,
                            total_tokens: metadataResponse.usage?.total_tokens || null,
                            reasoning_tokens: metadataResponse.usage?.completion_tokens_details?.reasoning_tokens || null,
                            cached_tokens: metadataResponse.usage?.prompt_tokens_details?.cached_tokens || null
                        })
                        .eq('id', document.id);
                    
                    if (updateError) {
                        console.error(`[${updateTimestamp}] ❌ ERROR updating document ${document.id}:`, updateError);
                    } else {
                        console.log(`[${updateTimestamp}] ✅ Successfully updated document ${document.id} with metadata and set status to 'processed'`);
                    }
                } catch (error) {
                    console.error(`[${updateTimestamp}] ❌ EXCEPTION during document update:`, error);
                    console.error(`[${updateTimestamp}] Stack trace:`, error.stack);
                }
                
                console.log(`[${new Date().toISOString()}] 🏁 FULL METADATA ONLY PROCESSING COMPLETE: ${filepath}`);
                
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
    // First strip diacritics from the entire input text
    let cleanedText = stripDiacritics(normalizeQuotes(text));
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
            // No need to strip diacritics again since cleanedText is already stripped
            const exactSimilarity = isSimilarEnough(exactText, normalizedItemText);
            
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
                // No need to strip diacritics again since cleanedText is already stripped
                const match = cleanedText.match(new RegExp(pattern));
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
                    
                    const beforeMatch = cleanedText.match(new RegExp(beforePattern));
                    const afterMatch = cleanedText.match(new RegExp(afterPattern));
                    
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
                // No need to strip diacritics again since cleanedText is already stripped
                const matches = cleanedText.match(new RegExp(escapeRegExp(normalizedItemText), 'g'));
                if (matches && matches.length === 1) {
                    const matchStart = cleanedText.indexOf(normalizedItemText);
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

/**
 * Extracts JSON content from a markdown formatted string, typically from LLM responses.
 * Handles both code blocks (``` delimited) and direct JSON objects ({ } delimited).
 * 
 * @param {string} text - The markdown-formatted text to process
 * @returns {string} - The extracted JSON content
 */
export function removeMarkdownFormatting(text) {
    if (!text) return '';
    
    // Trim initial input to remove leading/trailing whitespace
    const trimmedText = text.trim();
    console.log(`[MD-CLEANUP] Processing response of length ${trimmedText.length}`);
    
    // Case 1: Extract content from code blocks (between triple backticks)
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
    const match = trimmedText.match(codeBlockRegex);
    
    if (match && match[1]) {
        const extracted = match[1].trim();
        console.log(`[MD-CLEANUP] Extracted ${extracted.length} characters from code block`);
        return extracted;
    }
    
    // Case 2: If no code blocks but starts with { and ends with }, extract JSON directly
    // Find the first { and last } to handle stray text before/after JSON
    const firstBrace = trimmedText.indexOf('{');
    const lastBrace = trimmedText.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonContent = trimmedText.substring(firstBrace, lastBrace + 1).trim();
        console.log(`[MD-CLEANUP] Extracted ${jsonContent.length} characters using JSON pattern detection`);
        return jsonContent;
    }
    
    // Case 3: No code blocks or obvious JSON, return the input text (trimmed)
    console.log(`[MD-CLEANUP] No JSON pattern found, returning cleaned text of length ${trimmedText.length}`);
    return trimmedText;
}

async function createChunks(text, maxChunkLength, filepath) {
    const boundaryStyle = process.env.CHUNK_BOUNDARY_STYLE || 'indices';
    const chunkPrompt =
        boundaryStyle === 'text'
          ? OPENAI_PROMPTS.chunkText.content(maxChunkLength)
          : OPENAI_PROMPTS.chunk.content(maxChunkLength);
    const combinedPrompt = `${chunkPrompt}\n\n---\n\n${text}`;

    const response = await openai.chat.completions.create(
        createApiOptions(getModelForOperation('chunk'), [
            {
                role: "user",
                content: combinedPrompt
            }
        ])
    );

    await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);

    const cleanResponse = removeMarkdownFormatting(response.choices[0].message.content);
    // text parameter passed here must match exactly what was sent to LLM for indices to align
    const result = parseJsonResponse(cleanResponse, text, 'chunk');

    if (boundaryStyle === 'text' && result.chunks) {
        // 1) locate all start snippets first (guaranteed unique after cursor)
        const starts = [];
        let cursor = 0;
        result.chunks.forEach(({ startSnippet }) => {
            const idx = text.indexOf(startSnippet, cursor);
            if (idx === -1) throw new Error(`startSnippet not found: ${startSnippet}`);
            starts.push(idx);
            cursor = idx + 1;
        });

        // 2) compute end indices with bounded lastIndexOf
        result.chunks = result.chunks.map(({ endSnippet }, i) => {
            const searchLimit = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
            const endIdxRaw   = text.lastIndexOf(endSnippet, searchLimit);
            if (endIdxRaw === -1 || endIdxRaw < starts[i])
                throw new Error(`endSnippet not found/behind start for chunk ${i + 1}`);
            return {
                startIndex: starts[i],
                endIndex  : endIdxRaw + endSnippet.length - 1
            };
        });
    }

    if (result.chunks && result.textToRemove) {
        result.chunks = result.chunks.map(chunk => {
            // LLM returns 1-based → convert to 0-based inclusive
            const zeroStart = chunk.startIndex - 1;
            const zeroEnd   = chunk.endIndex   - 1;
            const originalText = cpSlice(text, zeroStart, zeroEnd);
            const cleanedText = cleanText(originalText, result.textToRemove);
            chunk.startIndex = zeroStart;
            chunk.endIndex   = zeroEnd;
            return {
                ...chunk,
                startIndex: zeroStart,
                endIndex  : zeroEnd,
                originalText,
                cleanedText
            };
        });
    }

    result.warnings = validateChunks(result.chunks, result.textToRemove.length, text.length);
    
    // Store in Supabase
    await saveAnalysis(text, 'chunk', { ...result, filepath });
    
    return result;
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
        const result = parseJsonResponse(response.choices[0].message.content, null, 'summarize');
        
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
        const result = parseJsonResponse(response.choices[0].message.content, null, 'sentiment');
        
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
        if (chunk.endIndex >= originalLength) {
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

/**
 * Enhanced findWordPosition for Hebrew and other RTL languages
 * 
 * This function is critical for accurate chunk boundary detection. When the LLM 
 * provides positions, they may not exactly match the actual text. This function:
 * 1. Tries exact matches first within a tolerance range
 * 2. Falls back to fuzzy matching for similar words 
 * 3. Uses different strategies for start vs. end positions
 * 4. Ensures positions are valid and within text bounds
 * 5. Adds special handling for RTL text and bidi control characters
 */
function findWordPosition(text, targetWord, nearPosition, isStart, previousChunkEnd = 0) {
    /* --- helpers ----------------------------------------------------- */
    const normalizeSpaces = str => str.replace(/\u00A0/g, ' ');
    const normalizeText = str => normalizeSpaces(str)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.,;:!?'"—–-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Special RTL marker handling
    const removeRTLMarkers = str => str
        .replace(/[\u200E\u200F\u202A-\u202E]/g, ''); // Remove bidi markers
    
    /* --- validate inputs --------------------------------------------- */
    nearPosition = Number(nearPosition);
    if (!targetWord || Number.isNaN(nearPosition)) {
        return isStart ? previousChunkEnd : 0;
    }

    /* --- set-up search window ---------------------------------------- */
    // Normalize and clean target word - also handle RTL markers
    const normalizedTarget = removeRTLMarkers(normalizeText(targetWord));
    
    // Use larger tolerance for Hebrew/RTL text (100 instead of default)
    const rtlTolerance = 100;
    const searchStart = Math.max(0, nearPosition - rtlTolerance);
    const searchEnd = Math.min(text.length, nearPosition + rtlTolerance);
    if (searchStart >= searchEnd) {
        return isStart ? previousChunkEnd : nearPosition;
    }
    
    // Normalize search area with RTL marker handling
    const searchArea = removeRTLMarkers(text.slice(searchStart, searchEnd));
    
    /* --- 1. exact match ---------------------------------------------- */
    const exactIdx = normalizeSpaces(searchArea).indexOf(normalizeSpaces(targetWord));
    if (exactIdx !== -1) return searchStart + exactIdx;

    /* --- 2. normalised / fuzzy search -------------------------------- */
    // Debug output for RTL character codes (helpful for debugging)
    console.log(`[RTL-DEBUG] Target word code points: ${[...normalizedTarget].map(c => c.codePointAt(0).toString(16)).join(' ')}`);
    
    // Use findBestMatch helper function from the original code
    const words = searchArea.split(/\s+/);
    let best = findBestMatch(words, normalizedTarget, searchArea, searchStart);
    if (best.position !== -1) return best.position;

    /* wider window for RTL text */
    const widerStart = Math.max(0, nearPosition - rtlTolerance * 2);
    const widerEnd   = Math.min(text.length, nearPosition + rtlTolerance * 2);
    const widerArea  = removeRTLMarkers(text.slice(widerStart, widerEnd));
    best = findBestMatch(widerArea.split(/\s+/), normalizedTarget, widerArea, widerStart);
    if (best.position !== -1) return best.position;

    /* --- 3. fallback -------------------------------------------------- */
    return isStart
        ? Math.max(previousChunkEnd, nearPosition)
        : Math.min(text.length, Math.max(previousChunkEnd + 1, nearPosition));
}

/**
 * Finds the best matching word from a list of candidates
 * 
 * @param {Array} words - Array of words to search through
 * @param {string} targetWord - The word to match against
 * @param {string} searchArea - The full text of the search area
 * @param {number} areaStartPosition - The starting position of the search area in the original text
 * @returns {Object} Best match result with position and word
 */
function findBestMatch(words, targetWord, searchArea, areaStartPosition) {
    const normalizeText = (str) => {
        return str.normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')  // Remove diacritics
            .replace(/[.,;:!?'"—–-]/g, ' ')    // Replace punctuation with spaces
            .replace(/\s+/g, ' ')              // Normalize spaces
            .trim();
    };
    
    let bestMatch = {
        word: null,
        similarity: 0,
        position: -1
    };
    
    // Single word exact match
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const normalizedWord = normalizeText(word);
        
        // For very short words, require exact match only
        if (normalizedWord === targetWord) {
            const wordPos = searchArea.indexOf(word);
            if (wordPos !== -1) {
                return {
                    word: word,
                    similarity: 1.0,
                    position: areaStartPosition + wordPos
                };
            }
        }
    }
    
    // Try multi-word combinations (up to 3 words) for better context
    for (let i = 0; i < words.length - 2; i++) {
        const phrase2 = words.slice(i, i + 2).join(' ');
        const phrase3 = words.slice(i, i + 3).join(' ');
        
        const normalizedPhrase2 = normalizeText(phrase2);
        const normalizedPhrase3 = normalizeText(phrase3);
        
        // Check if phrases contain the target word
        if (normalizedPhrase2.includes(targetWord) || normalizedPhrase3.includes(targetWord)) {
            const phrase2Pos = searchArea.indexOf(phrase2);
            const phrase3Pos = searchArea.indexOf(phrase3);
            
            if (phrase3Pos !== -1) {
                return {
                    word: phrase3,
                    similarity: 1.0,
                    position: areaStartPosition + phrase3Pos
                };
            }
            
            if (phrase2Pos !== -1) {
                return {
                    word: phrase2,
                    similarity: 1.0, 
                    position: areaStartPosition + phrase2Pos
                };
            }
        }
    }
    
    // Fuzzy matching using Levenshtein distance
    const MAX_SIMILARITY_THRESHOLD = 0.7; // Require at least 70% similarity
    
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const normalizedWord = normalizeText(word);
        
        // Skip very short words for fuzzy matching unless target is also short
        if (normalizedWord.length < 3 && targetWord.length >= 3) continue;
        
        // Use Levenshtein distance to compute similarity 
        const similarity = { 
            distance: levenshteinDistance(normalizedWord, targetWord),
            similarity: 0
        };
        
        // Calculate similarity score (1.0 = perfect match)
        const maxLength = Math.max(normalizedWord.length, targetWord.length);
        if (maxLength > 0) {
            similarity.similarity = 1 - (similarity.distance / maxLength);
        }
        
        // For short words, be more strict
        const threshold = targetWord.length <= 3 ? 0.8 : MAX_SIMILARITY_THRESHOLD;
        
        if (similarity.similarity > threshold && similarity.similarity > bestMatch.similarity) {
            const wordPos = searchArea.indexOf(word);
            if (wordPos !== -1) {
                bestMatch = {
                    word: word,
                    similarity: similarity.similarity,
                    position: areaStartPosition + wordPos
                };
            }
        }
    }
    
    // If best match meets threshold, return it
    if (bestMatch.similarity >= MAX_SIMILARITY_THRESHOLD) {
        console.log(`Found fuzzy match "${bestMatch.word}" with similarity ${bestMatch.similarity.toFixed(2)}`);
        return bestMatch;
    }
    
    // No good match found
    return { word: null, similarity: 0, position: -1 };
}

/**
 * Clean and chunk a document, preparing it for further processing
 * @param {string} content - The raw document content
 * @param {number} maxChunkLength - Maximum length for each chunk
 * @param {string} filepath - Path to the original file
 * @param {string} overview - Optional overview text to include
 * @param {boolean} skipMetadata - Whether to skip metadata generation
 * @param {boolean} isContinuation - Whether this document continues from a previous one
 * @param {string} groupNumber - Optional group number
 * @param {string} previousDocumentId - Deprecated - kept for backward compatibility
 * @param {string} inMemoryRemainderText - Remainder text from previous document (passed in memory)
 * @returns {Object} Processing results including chunks and warnings
 */
async function cleanAndChunkDocument(
  content,
  maxChunkLength,
  filepath,
  overview,
  skipMetadata,
  isContinuation,
  groupNumber,
  previousDocumentId,
  inMemoryRemainderText,
  isIncomplete = false              // ← NEW param
) {
    console.log('\n=== Starting Document Processing ===');
    console.log(`Total document length: ${content.length} characters`);
    console.log(`Continuation mode: ${isContinuation ? 'ON' : 'OFF'}`);
    console.log(`Group number: ${groupNumber || 'none'}`);

    // Extract header (first line) before any processing with detailed logging
    const lines = content.split('\n');
    console.log(`DEBUG: Total lines in content: ${lines.length}`);
    console.log(`DEBUG: First 5 lines:`);
    for (let i = 0; i < Math.min(5, lines.length); i++) {
        console.log(`DEBUG: Line ${i}: "${lines[i]}" (length: ${lines[i].length})`);
    }
    
    // Find first non-empty line
    let header = '';
    let headerLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine.length > 0) {
            header = trimmedLine;
            headerLineIndex = i;
            break;
        }
    }
    
    console.log(`DEBUG: Found header at line ${headerLineIndex}: "${header}"`);
    console.log(`Extracted header: "${header.substring(0, Math.min(50, header.length))}${header.length > 50 ? '...' : ''}"`);

    // Track remainder text for each pre-chunk
    let remainderText = '';
    
    // Store cleaning responses for token usage tracking
    let allCleanResponses = [];

    // If we have in-memory remainder text, use it directly
    if (isContinuation && inMemoryRemainderText !== null) {
        console.log('Using in-memory remainder text from previous document');
        console.log(`Remainder length: ${inMemoryRemainderText.length} characters`);
        
        // Initialize with previous remainder
        remainderText = inMemoryRemainderText;
        if (remainderText.length > 0) {
            console.log(`First 50 chars: "${remainderText.substring(0, Math.min(50, remainderText.length))}"`);
            console.log("REMAINDER-TRACK: Initialized with in-memory remainder");
        }
    } else if (isContinuation) {
        console.log("Continuation requested but no remainder text available");
        console.log("Using empty remainder (continuation without in-memory remainder is not supported)");
    } else {
        console.log('Not a continuation - starting with empty remainder');
    }
    
    // Save initial document with the raw content hash
    const document = await saveAnalysis(content, skipMetadata ? 'cleanAndChunk' : 'fullMetadata_only', { 
        filepath,
        groupNumber  // Make sure groupNumber is passed correctly
    });
    console.log('Saved original document with ID:', document.id);
    console.log('Using group number:', groupNumber || 'none');

    // Inspect document structure 
    console.log('\n========== DOCUMENT STRUCTURE CHECK ==========');
    console.log('document object type:', typeof document);
    console.log('document properties:', Object.keys(document));
    console.log('document.id:', document.id);
    console.log('document.document_source_id:', document.document_source_id);
    // Check if document is correctly formed
    if (!document.id) {
        console.error('⚠️ WARNING: document.id is missing!');
    }
    if (!document.document_source_id) {
        console.error('⚠️ WARNING: document.document_source_id is missing!');
    }
    console.log('========== END DOCUMENT STRUCTURE CHECK ==========\n');

    // Create new session for this document
    const currentSession = {
        messages: [],
        documentId: document.id
    };

    // Save the header to the document
    await supabase
        .from('documents')
        .update({ header })
        .eq('id', document.id);
    console.log(`Saved header to document ${document.id}`);

    // Pre-chunk the text
    const preChunks = preChunkText(content, OPENAI_SETTINGS.preChunkSize);
    console.log(`Created ${preChunks.length} pre-chunks`);
    
    let cleanedChunks = [];
    let allTextToRemove = [];
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
        console.log(`Saving pre-chunk ${i + 1} with document_id=${document.id}`);
        
        // Make sure we have the required document ID
        if (!document.id) {
            console.error('Error: Missing document.id - cannot save pre-chunk');
            continue; // Skip saving this pre-chunk but continue processing
        }
        
        try {
            // Ensure values are in the correct format
            const prechunkData = {
                document_id: document.id,
                chunk_index: i,
                text: chunk.text || '',
                start_position: parseInt(chunk.startPosition) || 0,
                end_position: parseInt(chunk.endPosition) || 0,
                is_complete: Boolean(chunk.isComplete),
                created_at: new Date().toISOString(),
                remainder_text: remainderText || '',
                remainder_length: (remainderText || '').length
            };
            
            // Double check all values are valid
            Object.entries(prechunkData).forEach(([key, value]) => {
                if (value === undefined || value === null) {
                    console.error(`Warning: ${key} is ${value} in prechunk`);
                    
                    // Provide safe defaults
                    if (key === 'text' || key === 'remainder_text') {
                        prechunkData[key] = '';
                    } else if (key === 'start_position' || key === 'end_position' || key === 'remainder_length') {
                        prechunkData[key] = 0;
                    } else if (key === 'is_complete') {
                        prechunkData[key] = false;
                    }
                }
            });
            
            // Insert prechunk and get the ID back in one operation
            const { data: insertedPrechunk, error: prechunkError } = await supabase
                .from('prechunks')
                .insert(prechunkData)
                .select('id')
                .single();

        if (prechunkError) {
            console.error(`Error saving pre-chunk ${i + 1}:`, prechunkError);
            if (prechunkError.details) {
                console.error(`Error details: ${prechunkError.details}`);
            }
            if (prechunkError.hint) {
                console.error(`Error hint: ${prechunkError.hint}`);
            }
        } else {
            console.log(`Saved pre-chunk ${i + 1} to database successfully`);

                // Store the prechunk ID in the preChunks array for later use
            if (insertedPrechunk && insertedPrechunk.id) {
                preChunks[i].prechunkId = insertedPrechunk.id;
                console.log(`Retrieved prechunk ID ${insertedPrechunk.id} for prechunk ${i + 1}`);
            } else {
                console.error(`No prechunk ID returned for prechunk ${i + 1}`);
            }
            }
        } catch (err) {
            console.error(`Exception saving pre-chunk ${i + 1}:`, err);
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
        
        // Add logging to show text being sent for cleaning
        debugLogText("RAW PRE-CHUNK TEXT (SENT FOR CLEANING)", 
            chunk.text.substring(0, Math.min(100, chunk.text.length)) + 
            (chunk.text.length > 200 ? '\n... [middle content omitted] ...\n' + 
            chunk.text.substring(chunk.text.length - 100) : ''), 
            false);
            
        const cleanResponse = await openai.chat.completions.create(
            createApiOptions(getModelForOperation('clean'), [
                OPENAI_PROMPTS.cleanAndChunk.clean(isIncomplete), // Always set isIncomplete=true for continuations
                {
                    role: "user",
                    content: chunk.text
                }
            ])
        );

        console.log('Clean response received');
        
        // Store the clean response for token usage
        allCleanResponses.push(cleanResponse);
        
        // Log token usage information for cleaning
        console.log(`[${new Date().toISOString()}] 📊 TOKEN USAGE for document cleaning:`, {
            prompt_tokens: cleanResponse.usage?.prompt_tokens || 'N/A',
            completion_tokens: cleanResponse.usage?.completion_tokens || 'N/A',
            total_tokens: cleanResponse.usage?.total_tokens || 'N/A',
            reasoning_tokens: cleanResponse.usage?.completion_tokens_details?.reasoning_tokens || 'N/A',
            cached_tokens: cleanResponse.usage?.prompt_tokens_details?.cached_tokens || 'N/A',
            raw_usage_object: JSON.stringify(cleanResponse.usage)
        });
        
        await logLLMResponse(null, cleanResponse.choices[0].message.content, OPENAI_SETTINGS.model);
        
        let cleanResult;
        try {
            cleanResult = parseJsonResponse(cleanResponse.choices[0].message.content, null, 'textRemoval');
        } catch (parseError) {
            console.warn('Failed to parse LLM response as JSON, storing raw response:', parseError.message);
            const { error: rawError } = await supabase
                .from('documents')
                .update({
                    raw_llm_response: cleanResponse.choices[0].message.content,
                    status          : 'parse_error',
                    error_message   : parseError.message,
                    updated_at      : new Date().toISOString()
                })
                .eq('id', document.id);
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
            
            // Add logging to show text after cleaning, before combining with remainder
            debugLogText("TEXT AFTER CLEANING (BEFORE COMBINING WITH REMAINDER)", 
                cleanedText.substring(0, Math.min(100, cleanedText.length)) + 
                (cleanedText.length > 200 ? '\n... [middle content omitted] ...\n' + 
                cleanedText.substring(cleanedText.length - 100) : ''), 
                false);
        } else if (cleanResult.textToRemove && cleanResult.textToRemove.length > 0) {
            // Apply the removal of identified problematic sections to get cleaned text
            // Use the original textToRemove positions as they're already relative to the chunk
            cleanedText = cleanText(chunk.text, cleanResult.textToRemove);
            
            // Add logging to show text after cleaning, before combining with remainder
            debugLogText("TEXT AFTER CLEANING (BEFORE COMBINING WITH REMAINDER)", 
                cleanedText.substring(0, Math.min(100, cleanedText.length)) + 
                (cleanedText.length > 200 ? '\n... [middle content omitted] ...\n' + 
                cleanedText.substring(cleanedText.length - 100) : ''), 
                false);
        } else {
            // If no textToRemove was identified, use the original text
            cleanedText = chunk.text;
            
            // Add logging to show text when no cleaning was performed
            debugLogText("ORIGINAL TEXT (NO CLEANING NEEDED)", 
                cleanedText.substring(0, Math.min(100, cleanedText.length)) + 
                (cleanedText.length > 200 ? '\n... [middle content omitted] ...\n' + 
                cleanedText.substring(cleanedText.length - 100) : ''), 
                false);
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
        if (i === 0 && isContinuation && remainderText.length > 0) {
            // We already included the remainder text at the beginning of finalCleanedText
            console.log('Continuation active - remainder is already included at the beginning of the text');
            debugLogText("TEXT WITH REMAINDER", finalCleanedText.substring(0, Math.min(100, finalCleanedText.length)), false);
        }

        console.log(`Preparing to chunk with total text length: ${finalCleanedText.length}`);

        /**
         * CRITICAL STEP 5: Send combined cleaned text to LLM for semantic chunking
         * 
         * Now we send the properly combined text (remainder + cleaned pre-chunk)
         * to the LLM to get semantically meaningful chunks.
         */
        console.log('Sending text for semantic chunking...');

        const boundaryStyle = process.env.CHUNK_BOUNDARY_STYLE || 'indices';
        const chunkPromptStr =
            boundaryStyle === 'text'
              ? OPENAI_PROMPTS.chunkText.content(maxChunkLength, /* isIncomplete */ false)
              : OPENAI_PROMPTS.cleanAndChunk.chunk(maxChunkLength, isIncomplete).content;
        const combinedPrompt = `${chunkPromptStr}\n\n---\n\n${finalCleanedText}`;

        const messages = [
            {
                role: "user",
                content: combinedPrompt
            }
        ];

        const chunkResponse = await openai.chat.completions.create(
            createApiOptions(getModelForOperation('chunk'), messages)
        );

        // Log and parse LLM's chunking response
        console.log('\nLLM Response Analysis:');
        console.log('----------------------------------------');
        
        // Add detailed logging of raw LLM chunking response
        console.log(`\n========== RAW LLM CHUNKING RESPONSE ==========`);
        const rawChunkResponse = chunkResponse.choices[0].message.content;
        console.log(`Response type: ${typeof rawChunkResponse}`);
        console.log(`Raw response (first 500 chars): ${rawChunkResponse.substring(0, 500)}...`);
        
        // Log token usage for chunking
        console.log(`[${new Date().toISOString()}] 📊 TOKEN USAGE for chunking:`, {
            prompt_tokens: chunkResponse.usage?.prompt_tokens || 'N/A',
            completion_tokens: chunkResponse.usage?.completion_tokens || 'N/A',
            total_tokens: chunkResponse.usage?.total_tokens || 'N/A',
            reasoning_tokens: chunkResponse.usage?.completion_tokens_details?.reasoning_tokens || 'N/A',
            cached_tokens: chunkResponse.usage?.prompt_tokens_details?.cached_tokens || 'N/A',
            raw_usage_object: JSON.stringify(chunkResponse.usage)
        });
        
        let parsedResponse;
        try {
            parsedResponse = parseJsonResponse(
                removeMarkdownFormatting(rawChunkResponse),
                finalCleanedText,
                'chunk'
            );
            // Ensure parsedResponse always has chunks array
            if (!parsedResponse.chunks) {
                parsedResponse.chunks = [];
                console.log("No chunks found in LLM response, initializing empty chunks array");
            } else {
                console.log(`\nNumber of chunks in raw response: ${parsedResponse.chunks.length}`);
                // Log ALL chunks with their positions to diagnose the issue
                console.log(`\n=== ALL CHUNK POSITIONS FROM LLM RESPONSE ===`);
                parsedResponse.chunks.forEach((chunk, i) => {
                    console.log(`Chunk ${i+1}: startIndex=${chunk.startIndex}, endIndex=${chunk.endIndex}, length=${chunk.endIndex - chunk.startIndex}`);
                });
                
                // Log the full response
                console.log(`\n========== FULL RAW LLM RESPONSE ==========`);
                console.log(rawChunkResponse);
                console.log(`========== END FULL RAW RESPONSE ==========\n`);
                
                // Extract text for all chunks
                for (const rawChunk of parsedResponse.chunks) {
                  const { title, startSnippet, endSnippet, startIndex, endIndex } = rawChunk;
                  let actualChunkContent = null;
                  let sIdxForDb = -1;
                  let eIdxForDb = -1;

                  logger.debug(`[openaiService] Processing LLM chunk for "${title}":`);
                  logger.debug(`  ┣━ LLM raw instruction: startIndex=${startIndex}, endIndex=${endIndex}`);
                  logger.debug(`  ┣━ LLM startSnippet: "${startSnippet?.replace(/\n/g, '\\n')}"`);
                  logger.debug(`  ┗━ LLM endSnippet: "${endSnippet?.replace(/\n/g, '\\n')}"`);

                  // Sanity check: Log the base text again, right before using it for snippet extraction
                  logger.debug(`  Base text for snippet extraction (len ${finalCleanedText?.length}): "${finalCleanedText?.substring(0, 100).replace(/\n/g, '\\n')}..."`);

                  const boundaryStyle = process.env.CHUNK_BOUNDARY_STYLE || 'indices';

                  // OPTION B: Prioritize snippets when boundary-style is 'text', regardless of whether indices exist
                  if (startSnippet && boundaryStyle === 'text') {
                    logger.info(`[openaiService] Chunk "${title}": Using SNIPPET-BASED strategy (boundary-style=text).`);
                    actualChunkContent = extractChunkBySnippets_V2({
                      text: finalCleanedText, // Crucial: This must be the full text the snippets refer to
                      startSnippet: startSnippet,
                      endSnippet: endSnippet,
                    });

                    if (actualChunkContent && actualChunkContent.length > 0) {
                      // Calculate indices ONLY for database storage
                      sIdxForDb = finalCleanedText.indexOf(actualChunkContent);
                      if (sIdxForDb !== -1) {
                        eIdxForDb = sIdxForDb + actualChunkContent.length - 1; // Make it inclusive for DB
                        logger.debug(`[openaiService] Snippet strategy for "${title}" SUCCESS.`);
                        logger.debug(`  ┣━ Derived DB indices: ${sIdxForDb}-${eIdxForDb}.`);
                        logger.debug(`  ┣━ Actual chunk content len: ${actualChunkContent.length}`);
                        logger.debug(`  ┗━ Content: "${actualChunkContent.substring(0, 200).replace(/\n/g, '\\n')}..."`);
                        if (actualChunkContent.length > 200) logger.debug(`    ... (content continues) ... "${actualChunkContent.substring(actualChunkContent.length - 200).replace(/\n/g, '\\n')}"`);
                      } else {
                        logger.error(`[openaiService] CRITICAL for "${title}": Snippet-extracted chunk NOT FOUND in base finalCleanedText. This is unexpected and indicates a mismatch.`);
                        logger.error(`  ┣━ Snippet-extracted chunk (len ${actualChunkContent?.length}): "${actualChunkContent?.substring(0, 200).replace(/\n/g, '\\n')}..."`);
                        logger.error(`  ┗━ Base finalCleanedText started with: "${finalCleanedText?.substring(0, Math.min(250, actualChunkContent?.length || 250)).replace(/\n/g, '\\n')}..."`);
                        actualChunkContent = null; // Mark as failed to prevent saving bad data
                      }
                    } else {
                      logger.warn(`[openaiService] Snippet strategy for "${title}" FAILED: extractChunkBySnippets_V2 returned null or empty string.`);
                      actualChunkContent = null;
                    }
                  } else if (typeof startIndex === 'number' && typeof endIndex === 'number' && startIndex < endIndex && endIndex <= finalCleanedText.length) {
                    logger.info(`[openaiService] Chunk "${title}": Using INDEX-BASED strategy (LLM indices: ${startIndex}-${endIndex}).`);
                    actualChunkContent = finalCleanedText.slice(startIndex, endIndex);
                    sIdxForDb = startIndex;
                    eIdxForDb = endIndex;
                    logger.debug(`  Index-based slice (len ${actualChunkContent?.length}): "${actualChunkContent?.substring(0,100).replace(/\n/g, '\\n')}..."`);
                  } else if (startSnippet) {
                    logger.info(`[openaiService] Chunk "${title}": Using SNIPPET-BASED strategy (fallback).`);
                    actualChunkContent = extractChunkBySnippets_V2({
                      text: finalCleanedText, // Crucial: This must be the full text the snippets refer to
                      startSnippet: startSnippet,
                      endSnippet: endSnippet,
                    });

                    if (actualChunkContent && actualChunkContent.length > 0) {
                      // Calculate indices ONLY for database storage
                      sIdxForDb = finalCleanedText.indexOf(actualChunkContent);
                      if (sIdxForDb !== -1) {
                        eIdxForDb = sIdxForDb + actualChunkContent.length - 1; // Make it inclusive for DB
                        logger.debug(`[openaiService] Snippet strategy for "${title}" SUCCESS.`);
                        logger.debug(`  ┣━ Derived DB indices: ${sIdxForDb}-${eIdxForDb}.`);
                        logger.debug(`  ┣━ Actual chunk content len: ${actualChunkContent.length}`);
                        logger.debug(`  ┗━ Content: "${actualChunkContent.substring(0, 200).replace(/\n/g, '\\n')}..."`);
                        if (actualChunkContent.length > 200) logger.debug(`    ... (content continues) ... "${actualChunkContent.substring(actualChunkContent.length - 200).replace(/\n/g, '\\n')}"`);
                      } else {
                        logger.error(`[openaiService] CRITICAL for "${title}": Snippet-extracted chunk NOT FOUND in base finalCleanedText. This is unexpected and indicates a mismatch.`);
                        logger.error(`  ┣━ Snippet-extracted chunk (len ${actualChunkContent?.length}): "${actualChunkContent?.substring(0, 200).replace(/\n/g, '\\n')}..."`);
                        logger.error(`  ┗━ Base finalCleanedText started with: "${finalCleanedText?.substring(0, Math.min(250, actualChunkContent?.length || 250)).replace(/\n/g, '\\n')}..."`);
                        actualChunkContent = null; // Mark as failed to prevent saving bad data
                      }
                    } else {
                      logger.warn(`[openaiService] Snippet strategy for "${title}" FAILED: extractChunkBySnippets_V2 returned null or empty string.`);
                      actualChunkContent = null;
                    }
                  } else {
                    logger.warn(`[openaiService] Chunk "${title}": No usable indices or startSnippet provided by LLM. Skipping chunk.`);
                    actualChunkContent = null;
                  }

                  if (actualChunkContent && sIdxForDb !== -1 && eIdxForDb !== -1) {
                    logger.info(`[openaiService] Chunk "${title}" processed successfully. Length: ${actualChunkContent.length}, Indices: ${sIdxForDb}-${eIdxForDb}`);
                    // CRITICAL: Attach the extracted content to the chunk object
                    rawChunk.cleanedText = actualChunkContent;
                    rawChunk.startIndex = sIdxForDb;
                    rawChunk.endIndex = eIdxForDb;
                  } else {
                    logger.warn(`[openaiService] Chunk "${title}" could not be processed or resulted in empty content.`);
                    // Mark failed chunks
                    rawChunk.cleanedText = null;
                  }
                }
            }
        } catch (parseError) {
            console.warn('Failed to parse chunk response as JSON:', parseError.message);
            // Store the raw response and continue
            const { error: rawError } = await supabase
                .from('documents')
                .update({
                    raw_llm_response: chunkResponse.choices[0].message.content,
                    error_message   : parseError.message,
                    updated_at      : new Date().toISOString()
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
            
            /**
             * SNIPPET-BASED VS INDEX-BASED CHUNKING LOGIC
             * 
             * For snippet-based chunking (boundary-style=text):
             * - LLM returns positions relative to finalCleanedText (which includes remainder)
             * - Snippet extraction already found exact positions - no adjustment needed
             * - No cumulative drift, no overlap issues, no word boundary detection needed
             * 
             * For index-based chunking (boundary-style=indices):
             * - Use traditional word boundary detection and position adjustment
             * - Track cumulative drift and handle overlaps
             */
            
            if (boundaryStyle === 'text') {
                // SNIPPET-BASED: Use positions from snippet extraction directly
                console.log('\n======== SNIPPET-BASED PROCESSING ========');
                console.log('Using snippet extraction results directly (no word boundary adjustments)');
                
                parsedResponse.chunks = parsedResponse.chunks.map((chunk, index) => {
                    console.log(`\nChunk ${index + 1} (Snippet-Based):`);
                    console.log(`- Start: ${chunk.startIndex}, End: ${chunk.endIndex}`);
                    console.log(`- Start snippet: "${chunk.startSnippet?.substring(0, 50)}${chunk.startSnippet?.length > 50 ? '...' : ''}"`);
                    console.log(`- End snippet: "${chunk.endSnippet?.substring(0, 50)}${chunk.endSnippet?.length > 50 ? '...' : ''}"`);

                    // Use the positions directly from snippet extraction
                    const startIdxForDb = chunk.startIndex;
                    const endIdxForDb = chunk.endIndex;

                    // Extract content using the snippet-based positions
                    const actualChunkContent = finalCleanedText.slice(startIdxForDb, endIdxForDb + 1);

                    console.log(`- Content length: ${actualChunkContent.length} characters`);
                    console.log(`- Content preview: "${actualChunkContent.substring(0, 50)}${actualChunkContent.length > 50 ? '...' : ''}"`);

                    return {
                        ...chunk,
                        startIndex: startIdxForDb,
                        endIndex: endIdxForDb,
                        cleanedText: actualChunkContent,
                        startSnippet: chunk.startSnippet,
                        endSnippet: chunk.endSnippet
                    };
                });
                console.log('======== END SNIPPET-BASED PROCESSING ========');
                
            } else {
                // INDEX-BASED: Use traditional word boundary detection
                console.log('\n======== INDEX-BASED PROCESSING ========');
                console.log('Using word boundary detection for index-based chunking');
                
            let cumulativeOffset = 0;  // Resets for each prechunk's LLM call
            let previousAdjustedEnd = 0;  // Tracks last chunk's end position
            let previousEndSnippetTxt = ''; // for start-shift fix
            
            parsedResponse.chunks = parsedResponse.chunks.map((chunk, index) => {
                console.log(`\nChunk ${index + 1}:`);
                console.log(`Original: Start: ${chunk.startIndex}, End: ${chunk.endIndex}`);
                console.log(`After offset adjustment: Start: ${chunk.startIndex + cumulativeOffset}, End: ${chunk.endIndex + cumulativeOffset}`);

                console.log(`\n======== WORD BOUNDARY DETECTION - CHUNK ${index + 1} ========`);
                console.log("Finding exact word boundaries for precise chunking:");
                console.log(`- First word to find: "${chunk.startSnippet}"`);
                console.log(`- Last word to find: "${chunk.endSnippet}"`);
                console.log(`- Starting search at positions: ${chunk.startIndex + cumulativeOffset}-${chunk.endIndex + cumulativeOffset}`);

                let alignedStartIdx = findWordPosition(
                    finalCleanedText,
                    chunk.startSnippet,
                    chunk.startIndex + cumulativeOffset,
                    true, // isStart
                    previousAdjustedEnd // Pass the end of the previous chunk
                );

                // --- 1️⃣  keep chunks contiguous (old logic) ----------
                if (index > 0 && alignedStartIdx > previousAdjustedEnd + 1) {
                    const oldAlignedStartIdx = alignedStartIdx;
                    alignedStartIdx = previousAdjustedEnd + 1;
                    logger.warn(`[CONTIGUOUS_CHUNK_FIX] Chunk ${index + 1} start index adjusted to be contiguous. Was: ${oldAlignedStartIdx}, Now: ${alignedStartIdx}. Previous chunk ended at: ${previousAdjustedEnd}`);
                }
                // --- 2️⃣  NEW start-shift to drop overlap ------------
                const shiftedStartIdx = shiftStartIndexByPrevSnippet(
                  alignedStartIdx,
                  previousEndSnippetTxt
                );
                if (shiftedStartIdx !== alignedStartIdx) {
                  logger.warn(
                    `[START_OVERLAP_FIX] Chunk ${index + 1} start moved ` +
                    `from ${alignedStartIdx} → ${shiftedStartIdx} ` +
                    `(prev end-snippet length ${previousEndSnippetTxt.length})`
                  );
                  alignedStartIdx = shiftedStartIdx;
                }
                // ------------------------------------------------------

                let alignedEndIdx = findWordPosition(
                    finalCleanedText,
                    chunk.endSnippet,
                    chunk.endIndex + cumulativeOffset,
                    false, // isStart
                    alignedStartIdx // Pass the (potentially adjusted) start of the current chunk
                );

                console.log('\nWORD BOUNDARY RESULTS:');
                console.log(`- Original positions: ${chunk.startIndex}-${chunk.endIndex}`);
                console.log(`- Final adjusted positions: ${alignedStartIdx}-${alignedEndIdx}`);
                const startChange = alignedStartIdx - (chunk.startIndex + cumulativeOffset);
                const endChange = alignedEndIdx - (chunk.endIndex + cumulativeOffset);
                console.log(`- Position change: start ${startChange}, end ${endChange}`);
                console.log('======== END WORD BOUNDARY DETECTION ========');

                const drift = (alignedEndIdx - (chunk.endIndex + cumulativeOffset));
                console.log(`\nPosition drift: ${drift} characters from LLM's calculation (will be applied to future chunks)`);
                cumulativeOffset += drift;
                console.log(`Positions adjusted: ${chunk.startIndex + cumulativeOffset - drift}-${chunk.endIndex + cumulativeOffset - drift} -> ${alignedStartIdx}-${alignedEndIdx}`);

                const startIdxForDb = alignedStartIdx;
                const endIdxForDb = alignedEndIdx; // Assuming findWordPosition for end is already inclusive or handled by appendEndSnippetIfMissing

                //  `endIdxForDb` is inclusive → add 1 for JS slice
                const actualChunkContent =
                  finalCleanedText.slice(startIdxForDb, endIdxForDb + 1);

                console.log('Re-extracted text with adjusted boundaries');
                console.log(`Final text: ${actualChunkContent.substring(0,30)}...`);

                // Update previousAdjustedEnd for the next iteration
                previousAdjustedEnd = endIdxForDb;
                previousEndSnippetTxt = chunk.endSnippet ?? '';

                return {
                    ...chunk,
                    startIndex: startIdxForDb,
                    endIndex: endIdxForDb,
                    cleanedText: actualChunkContent,
                    startSnippet: chunk.startSnippet,
                    endSnippet: chunk.endSnippet,
                    startSnippetPosition: chunk.startIndex + cumulativeOffset,
                    endSnippetPosition: chunk.endIndex + cumulativeOffset
                };
            });
                console.log('======== END INDEX-BASED PROCESSING ========');
            }
        } else {
            // If LLM didn't return chunks, treat entire cleaned text as remainder
            remainderText = finalCleanedText;
            console.log("[TRACK] UPDATED: remainderText = finalCleanedText (entire text) because no chunks returned");
            console.log("[TRACK] new remainderText length: " + remainderText.length + " chars");
            console.log('No chunks returned, entire text is remainder');
            
            // Ensure parsedResponse has a chunks array
            parsedResponse.chunks = [];
        }

        // Ensure chunkResult is always defined with at least empty arrays
        const chunkResult = {
            chunks: parsedResponse.chunks || [],
            warnings: parsedResponse.warnings || [],
            tokenUsage: chunkResponse.usage
        };
        
        // Add detailed logging for remainder text
        console.log('\n=== REMAINDER TEXT CALCULATION ===');
        console.log(`Current finalCleanedText length: ${finalCleanedText.length} chars`);
        
        // Log the first and last 50 characters of finalCleanedText for debugging
        if (finalCleanedText.length > 0) {
            console.log(`First 50 chars: "${finalCleanedText.substring(0, Math.min(50, finalCleanedText.length))}"`);
            if (finalCleanedText.length > 100) {
                console.log(`Last 50 chars: "${finalCleanedText.substring(Math.max(0, finalCleanedText.length - 50))}"`);
            }
        }

        // Calculate the new remainder text after all chunks have been processed
        // The remainder text is everything in finalCleanedText that comes after the last chunk's end
        const lastChunk = chunkResult?.chunks?.length > 0 ? chunkResult.chunks[chunkResult.chunks.length - 1] : null;
        
        /**
         * IMPROVED REMAINDER HANDLING
         * 
         * This section determines whether to create a remainder and how to handle it.
         * Key improvements:
         * 1. Now respects the LLM's explicit "remainder" flag (true/false)
         * 2. Checks if the last chunk actually reaches the end of the document
         * 3. Creates a remainder if text remains unprocessed, regardless of flag
         * 4. Logs detailed information about remainder creation decisions
         * 
         * This ensures no content is lost while still respecting LLM's semantic decisions.
         */
        
        // Check if the LLM explicitly set a remainder flag in its response
        const llmRequestsRemainder = parsedResponse.remainder === true;
        console.log(`LLM explicitly requested remainder: ${llmRequestsRemainder ? 'YES' : 'NO'}`);
        
        // Check if the last chunk reaches the end of the document (with some tolerance)
        const END_TOLERANCE = 10; // Allow 10 characters of tolerance
        const lastChunkEndIndex = lastChunk ? (lastChunk.adjustedEndIndex || lastChunk.endIndex) - 1 : 0; // Convert to 0-indexed
        const reachesEnd = lastChunkEndIndex >= finalCleanedText.length - END_TOLERANCE;
        console.log(`Last chunk reaches end of document: ${reachesEnd ? 'YES' : 'NO'}`);
        console.log(`Last chunk end position: ${lastChunkEndIndex+1}, Document length: ${finalCleanedText.length}`);
        console.log(`Distance from end: ${finalCleanedText.length - lastChunkEndIndex - 1} characters`);
        
        // Determine if we should create a remainder:
        // 1. LLM explicitly requests remainder, OR
        // 2. LLM doesn't specify (undefined), OR
        // 3. The last chunk doesn't reach the end of the document (regardless of remainder flag)
        const shouldCreateRemainder = llmRequestsRemainder || 
                                      parsedResponse.remainder === undefined || 
                                      (lastChunk && !reachesEnd);
        
        if (lastChunk && !lastChunk.drop_remaining && shouldCreateRemainder) {
            /**
             * REMAINDER CALCULATION
             * 
             * The remainder is calculated using adjustedEndIndex when available,
             * which has been precisely determined using word boundary detection.
             * 
             * This ensures the remainder starts at an accurate word boundary that
             * accounts for all position adjustments (including cumulative offset).
             */
            // Only update remainderText if the last processed chunk is valid
            // Get everything after the last chunk's end index
            // Use adjustedEndIndex if available, fall back to endIndex
            const endPosition = lastChunkEndIndex; // Already converted to 0-indexed above
            remainderText = finalCleanedText.substring(endPosition);
            
            // Log the reason for creating a remainder
            if (llmRequestsRemainder) {
                console.log(`[TRACK] Creating remainder because LLM explicitly requested it (remainder=true)`);
            } else if (parsedResponse.remainder === undefined) {
                console.log(`[TRACK] Creating remainder because LLM didn't specify (remainder is undefined)`);
            } else if (!reachesEnd) {
                console.log(`[TRACK] Creating remainder because last chunk doesn't reach end of document (${finalCleanedText.length - lastChunkEndIndex - 1} chars remaining)`);
            }
            
            console.log(`[TRACK] UPDATED: remainderText = text after last chunk (${endPosition} to end)`);
            console.log(`[TRACK] new remainderText length: ${remainderText.length} chars`);
            
            // Log the first 50 characters of the remainder for debugging
            if (remainderText.length > 0) {
                console.log(`Remainder first 50 chars: "${remainderText.substring(0, Math.min(50, remainderText.length))}"`);
                if (remainderText.length > 100) {
                    console.log(`Remainder last 50 chars: "${remainderText.substring(Math.max(0, remainderText.length - 50))}"`);
                }
            }
        } else if (lastChunk && !lastChunk.drop_remaining && parsedResponse.remainder === false && reachesEnd) {
            // LLM explicitly indicated no remainder needed AND the last chunk reaches the end
            console.log("LLM indicated no remainder is needed (remainder: false) and last chunk reaches end of document");
            console.log("Last chunk will be included as a regular chunk, not converted to remainder");
            remainderText = "";
        }
        
        // Save the current chunkResult for this pre-chunk iteration
        cleanedChunks = [...cleanedChunks, ...chunkResult.chunks];
    }

    // Create a final chunkResult to be returned
    const finalChunkResult = {
        chunks: cleanedChunks,
        warnings: [],
        // Store token usage for tracking
        tokenUsage: cleanedChunks.length > 0 && cleanedChunks[0].tokenUsage ? 
            cleanedChunks[0].tokenUsage : null
    };

    // Log final remainder text details before returning
    console.log('\n=== FINAL REMAINDER TEXT DETAILS ===');
    console.log(`Final remainder length: ${remainderText.length} chars`);
    if (remainderText.length > 0) {
        console.log(`First 50 chars: "${remainderText.substring(0, Math.min(50, remainderText.length))}"`);
        if (remainderText.length > 100) {
            console.log(`Last 50 chars: "${remainderText.substring(Math.max(0, remainderText.length - 50))}"`);
        }
    } else {
        console.log('No remainder text');
    }

    // At the end of function, update the document with chunks and remainder text
    // This replaces the second saveAnalysis call that was in index.mjs
    try {
        // Update the document status (do NOT store remainder text in database)
        await supabase
            .from('documents')
            .update({
                status: 'processed',
                warnings: finalChunkResult.warnings || [],
                updated_at: new Date().toISOString()
            })
            .eq('id', document.id);
            
        // Process and save chunks with document source ID
        if (finalChunkResult.chunks && finalChunkResult.chunks.length > 0) {
            console.log(`\n========== FINAL CHUNK PROCESSING DIAGNOSTICS ==========`);
            console.log(`Processing ${finalChunkResult.chunks.length} chunks for database insertion...`);
            console.log(`Document ID: ${document?.id || 'MISSING!'}`);
            console.log(`Document Source ID: ${document?.document_source_id || 'MISSING!'}`);
            
            // Detailed check of first chunk
            if (finalChunkResult.chunks.length > 0) {
                const sampleChunk = finalChunkResult.chunks[0];
                console.log(`Sample chunk before processing:`, {
                    startIndex: sampleChunk.startIndex,
                    endIndex: sampleChunk.endIndex,
                    cleanedText: sampleChunk.cleanedText?.substring(0, 30) + '...',
                    hasWarnings: (sampleChunk.warnings && sampleChunk.warnings.length > 0) ? 'YES' : 'NO'
                });
            }
            
            // Add first_word and last_word fields and prepare for insertion
            const chunksToSave = finalChunkResult.chunks.map(chunk => {
                // Get the first and last word for the chunk
                const cleanedText = chunk.cleanedText?.trim() || '';
                const words = cleanedText.split(/\s+/).filter(w => w.length > 0);
                const firstWord = words.length > 0 ? words[0] : '';
                const lastWord = words.length > 0 ? words[words.length - 1] : '';
                
                console.log(`Chunk text stats: length=${cleanedText.length}, words=${words.length}, first=${firstWord}, last=${lastWord}`);
                
                // Include token usage from chunking API call
                chunk.input_tokens = finalChunkResult.tokenUsage?.prompt_tokens || null;
                chunk.output_tokens = finalChunkResult.tokenUsage?.completion_tokens || null;
                chunk.total_tokens = finalChunkResult.tokenUsage?.total_tokens || null;
                chunk.reasoning_tokens = finalChunkResult.tokenUsage?.completion_tokens_details?.reasoning_tokens || null;
                chunk.cached_tokens = finalChunkResult.tokenUsage?.prompt_tokens_details?.cached_tokens || null;
                
                // Find the corresponding prechunk for this chunk
                let prechunkId = null;
                // Loop through preChunks to find the one that contains this chunk's start position
                console.log(`DEBUG: Looking for prechunk match for chunk starting at ${chunk.adjustedStartIndex || chunk.startIndex}`);
                console.log(`DEBUG: Available preChunks:`, preChunks.map(pc => ({
                    index: pc.chunkIndex,
                    startPos: pc.startPosition,
                    endPos: pc.endPosition,
                    prechunkId: pc.prechunkId
                })));
                
                for (const preChunk of preChunks) {
                    const startPos = chunk.adjustedStartIndex || chunk.startIndex;
                    const chunkStartPos = parseInt(startPos);
                    const preChunkStart = parseInt(preChunk.startPosition);
                    const preChunkEnd = parseInt(preChunk.endPosition);
                    
                    console.log(`DEBUG: Checking prechunk ${preChunk.chunkIndex}: range ${preChunkStart}-${preChunkEnd}, chunk starts at ${chunkStartPos}, prechunkId=${preChunk.prechunkId}`);
                    
                    // If the chunk starts within this prechunk's range and we have a stored prechunkId
                    // Use more flexible matching to account for position shifts after cleaning
                    const isWithinRange = chunkStartPos >= preChunkStart && chunkStartPos <= preChunkEnd;
                    const isCloseToStart = Math.abs(chunkStartPos - preChunkStart) <= 5; // Allow 5 char tolerance at start
                    const isCloseToEnd = Math.abs(chunkStartPos - preChunkEnd) <= 5; // Allow 5 char tolerance at end
                    
                    if ((isWithinRange || isCloseToStart || isCloseToEnd) && preChunk.prechunkId) {
                        prechunkId = preChunk.prechunkId;
                        console.log(`Found matching prechunk ${prechunkId} for chunk starting at position ${chunkStartPos} (tolerance matching)`);
                        break;
                    }
                }
                
                if (!prechunkId && preChunks.length > 0) {
                    console.log(`WARNING: No matching prechunk found for chunk starting at ${chunk.adjustedStartIndex || chunk.startIndex}`);
                    // Fallback: Use the first available prechunk ID if there's only one prechunk
                    if (preChunks.length === 1 && preChunks[0].prechunkId) {
                        prechunkId = preChunks[0].prechunkId;
                        console.log(`FALLBACK: Using single available prechunk ID ${prechunkId}`);
                    }
                }
                
                return {
                    ...chunk,
                    /**
                     * FINALIZED POSITIONS
                     * 
                     * Always use the adjustedStartIndex/adjustedEndIndex for chunk boundaries
                     * if available. These positions have been carefully determined through:
                     * 1. Cumulative offset adjustment within the prechunk
                     * 2. Word boundary detection
                     * 3. Safety checks to ensure valid ranges
                     * 
                     * These positions correctly account for remainder text because they
                     * are based on finalCleanedText which already includes remainder.
                     */
                    startIndex: chunk.adjustedStartIndex || chunk.startIndex,
                    endIndex: chunk.adjustedEndIndex || chunk.endIndex,
                    firstWord,
                    lastWord,
                    // Additional metrics for database storage
                    within_tolerance: chunk.within_tolerance || false,
                    position_difference: chunk.position_difference || 0,
                    llm_suggested_end: chunk.llm_suggested_end || chunk.endIndex,
                    actual_end: chunk.actual_end || (chunk.adjustedEndIndex || chunk.endIndex),
                    first_word_match: chunk.first_word_match || false,
                    last_word_match: chunk.last_word_match || false,
                    // Add the prechunk ID reference
                    prechunk_id: prechunkId
                };
            });
            
            console.log(`After processing: ${chunksToSave.length} chunks ready for saveAnalysis`);
            
            // Display first chunk that will be saved
            if (chunksToSave.length > 0) {
                console.log(`First chunk to save (after processing):`, {
                    startIndex: chunksToSave[0].startIndex,
                    endIndex: chunksToSave[0].endIndex,
                    firstWord: chunksToSave[0].firstWord,
                    lastWord: chunksToSave[0].lastWord,
                    cleanedTextLength: chunksToSave[0].cleanedText?.length || 0
                });
            }
            
            // Save via saveAnalysis
            try {
                console.log(`Calling saveAnalysis with 'chunk_direct_save' type, ${chunksToSave.length} chunks`);
                console.log(`Document source ID being passed: ${document.document_source_id}`);
                
                await saveAnalysis(content, 'chunk_direct_save', {
                    document: document,
                    document_source_id: document.document_source_id,
                    chunks: chunksToSave
                });
                console.log(`✅ saveAnalysis call completed for ${chunksToSave.length} chunks`);
                
                // Process and save metadata for each chunk
                if (!skipMetadata && chunksToSave.length > 0) {
                    console.log(`\n========== CHUNK METADATA PROCESSING ==========`);
                    console.log(`Generating metadata for ${chunksToSave.length} chunks...`);
                    
                    // Process chunks concurrently instead of sequentially
                    const metadataPromises = chunksToSave.map(async (chunk, i) => {
                        console.log(`\n----- Started processing metadata for chunk ${i+1}/${chunksToSave.length} -----`);
                        
                        try {
                            // Only process chunks with actual content
                            if (chunk.cleanedText && chunk.cleanedText.trim().length > 0) {
                                // Generate metadata using the metadata prompt
                                console.log(`Calling OpenAI API for chunk ${i+1} metadata...`);
                                const metadataResponse = await openai.chat.completions.create(
                                    createApiOptions(getModelForOperation('metadata'), [
                                        OPENAI_PROMPTS.metadata(false),
                                        {
                                            role: "user",
                                            content: chunk.cleanedText
                                        }
                                    ])
                                );
                                
                                console.log(`Received metadata response for chunk ${i+1}`);
                                const rawResponse = metadataResponse.choices[0].message.content;
                                const cleanedResponse = removeMarkdownFormatting(rawResponse);
                                const metadata = parseJsonResponse(cleanedResponse, null, 'metadata');
                                
                                // Verify this is a valid metadata object (not a chunks object)
                                if (metadata.chunks) {
                                    console.error(`❌ ERROR: Metadata for chunk ${i+1} was parsed as a chunks object instead of metadata`);
                                    console.log(`Response structure:`, Object.keys(metadata));
                                    // Continue with the next chunk, but still save the raw response
                                    await saveChunkMetadata(
                                        document.id, 
                                        i, 
                                        {
                                            long_summary: "Error: Response contained chunks instead of metadata",
                                            short_summary: "Parsing error",
                                            generated_title: "Metadata Structure Error"
                                        }, 
                                        metadataResponse.model,
                                        rawResponse,  // Save the raw response even on error
                                        {usage: metadataResponse.usage}  // Add API metadata with token usage
                                    );
                                    return;
                                }
                                
                                // Add model information to the metadata
                                console.log(`Model used for metadata: ${metadataResponse.model}`);
                                
                                // Add detailed token usage logging
                                console.log(`[${new Date().toISOString()}] 📊 TOKEN USAGE for chunk ${i+1}:`, {
                                    prompt_tokens: metadataResponse.usage?.prompt_tokens || 'N/A',
                                    completion_tokens: metadataResponse.usage?.completion_tokens || 'N/A',
                                    total_tokens: metadataResponse.usage?.total_tokens || 'N/A',
                                    reasoning_tokens: metadataResponse.usage?.completion_tokens_details?.reasoning_tokens || 'N/A',
                                    cached_tokens: metadataResponse.usage?.prompt_tokens_details?.cached_tokens || 'N/A',
                                    raw_usage_object: JSON.stringify(metadataResponse.usage)
                                });
                                
                                // Save the metadata with model information and raw response
                                await saveChunkMetadata(
                                    document.id, 
                                    i, 
                                    metadata, 
                                    metadataResponse.model,
                                    rawResponse,  // Save the raw response
                                    {usage: metadataResponse.usage}  // Add API metadata with token usage
                                );
                                console.log(`✅ Saved metadata for chunk ${i+1} using model: ${metadataResponse.model}`);
                            } else {
                                console.log(`⚠️ Skipping metadata for chunk ${i+1} - no valid content`);
                            }
                        } catch (metadataError) {
                            console.error(`Error processing metadata for chunk ${i+1}:`, metadataError);
                            // Continue with next chunk even if this one fails
                        }
                        
                        console.log(`----- Completed processing for chunk ${i+1}/${chunksToSave.length} -----`);
                    });
                    
                    // Wait for all metadata processing to complete
                    await Promise.all(metadataPromises);
                    
                    console.log(`========== END CHUNK METADATA PROCESSING ==========`);
                } else if (skipMetadata) {
                    console.log(`Skipping metadata generation (skipMetadata=true)`);
                }
            } catch (chunkError) {
                console.error('🚨 ERROR: Failed to save chunks via saveAnalysis:', chunkError);
                if (chunkError.code) {
                    console.error('Error code:', chunkError.code);
                }
                if (chunkError.details) {
                    console.error('Error details:', chunkError.details);
                }
            }
            console.log(`========== END CHUNK PROCESSING DIAGNOSTICS ==========`);
        } else {
            console.log('No chunks to save to database');
        }
        
        console.log(`Updated document ${document.id} with ${finalChunkResult.chunks.length} chunks (remainder text kept in memory only)`);
    } catch (error) {
        console.error('Error updating document with chunks:', error);
    }
    
    // Add this after all chunks are processed - around line 1830
    // Save the final cleaned text to the database if we have it
    if (finalCleanedText && finalCleanedText.length > 0) {
        console.log(`\n[${new Date().toISOString()}] 💾 Saving final cleaned document text to the database`);
        try {
            // Get the token usage from the first cleaning response if available
            const tokenUsage = allCleanResponses.length > 0 ? allCleanResponses[0].usage : null;
            
            // Log combined token usage if we have multiple cleaning responses
            if (allCleanResponses.length > 1) {
                const combinedUsage = {
                    prompt_tokens: allCleanResponses.reduce((sum, resp) => sum + (resp.usage?.prompt_tokens || 0), 0),
                    completion_tokens: allCleanResponses.reduce((sum, resp) => sum + (resp.usage?.completion_tokens || 0), 0),
                    total_tokens: allCleanResponses.reduce((sum, resp) => sum + (resp.usage?.total_tokens || 0), 0)
                };
                
                console.log(`[${new Date().toISOString()}] 📊 COMBINED TOKEN USAGE for all cleaning operations:`, combinedUsage);
                
                // For detailed token tracking, we'll use the first response since combining these is more complex
            }
            
            await saveCleanedDocument(
                document.id, 
                finalCleanedText,
                content,
                getModelForOperation('clean'),
                tokenUsage
            );
            console.log(`[${new Date().toISOString()}] ✅ Successfully saved cleaned document text`);
        } catch (saveError) {
            console.error(`[${new Date().toISOString()}] ❌ Error saving cleaned document:`, saveError);
        }
    } else {
        console.log(`[${new Date().toISOString()}] ⚠️ No cleaned document text to save`);
    }
    
    return {
        chunks: finalChunkResult.chunks,
        remainderText: remainderText,
        warnings: finalChunkResult.warnings
    };
}

/**
 * Utility function for logging text samples with appropriate formatting
 * 
 * This function provides a consistent way to log text samples with clear formatting,
 * making it easier to trace the flow of text through the processing pipeline.
 * 
 * @param {string} label - Label for the text sample
 * @param {string} text - The text to log
 * @param {boolean} isRemainder - Whether this is remainder text
 */
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
    
    // Import the detectUnexpectedEntries function
    const { detectUnexpectedEntries } = await import('./supabaseService.mjs');
    
    // Check for any unexpected entries before starting
    await detectUnexpectedEntries(null);
    
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
            
            // Check for any unexpected entries before processing this document
            if (doc.original_filename) {
                await detectUnexpectedEntries(doc.original_filename);
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
            const metadata = parseJsonResponse(cleanedResponse, null, 'fullMetadata');
            
            // Add detailed token usage logging
            console.log(`[${new Date().toISOString()}] 📊 TOKEN USAGE for document ${docId}:`, {
                prompt_tokens: metadataResponse.usage?.prompt_tokens || 'N/A',
                completion_tokens: metadataResponse.usage?.completion_tokens || 'N/A',
                total_tokens: metadataResponse.usage?.total_tokens || 'N/A',
                reasoning_tokens: metadataResponse.usage?.completion_tokens_details?.reasoning_tokens || 'N/A',
                cached_tokens: metadataResponse.usage?.prompt_tokens_details?.cached_tokens || 'N/A',
                raw_usage_object: JSON.stringify(metadataResponse.usage)
            });
            
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
                    category: metadata.category,
                    novel_approaches: metadata.novel_approaches,
                    api_metadata: apiMetadata,
                    updated_at: new Date().toISOString(),
                    input_tokens: metadataResponse.usage?.prompt_tokens || null,
                    output_tokens: metadataResponse.usage?.completion_tokens || null,
                    total_tokens: metadataResponse.usage?.total_tokens || null,
                    reasoning_tokens: metadataResponse.usage?.completion_tokens_details?.reasoning_tokens || null,
                    cached_tokens: metadataResponse.usage?.prompt_tokens_details?.cached_tokens || null
                })
                .eq('id', docId);
                
            if (updateError) {
                console.error(`Error updating document ${docId}:`, updateError);
            } else {
                console.log(`Successfully processed metadata for document ${docId}`);
            }
            
            // Check for any unexpected entries after processing this document
            if (doc.original_filename) {
                await detectUnexpectedEntries(doc.original_filename);
            }
        } catch (error) {
            console.error(`Error processing metadata for document ${docId}:`, error.message);
        }
    }
    
    return { success: true };
}

export async function getOpenAIEmbedding(text, model = OPENAI_SETTINGS.embedding.model) {
  const {
    data: [resp],
  } = await openai.embeddings.create({ model, input: text });
  return resp.embedding;
}

// Slice by Unicode-code-point with inclusive end index
const cpSlice = (str, start, endInc) => Array.from(str).slice(start, endInc + 1).join('');

// --- ✨ NEW HELPERS ---------------------------------------------------------
/**
 * Very small Levenshtein implementation (O(n*m), good enough for ≤200 chars)
 */
function levenshtein(a, b) {
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const matrix = Array.from({ length: al + 1 }, (_, i) => [i]);
  for (let j = 1; j <= bl; j++) matrix[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,          // deletion
        matrix[i][j - 1] + 1,          // insertion
        matrix[i - 1][j - 1] + cost    // substitution
      );
    }
  }
  return matrix[al][bl];
}

/**
 * Fuzzy search for snippet inside text starting at fromIdx.
 * Returns index or -1.
 */
function fuzzyIndexOf(text, snippet, fromIdx = 0, maxDistance = 5, scanWindow = 1000) {
  const windowEnd = Math.min(text.length, fromIdx + scanWindow);
  const sLen = snippet.length;
  for (let i = fromIdx; i <= windowEnd - sLen; i++) {
    if (levenshtein(text.slice(i, i + sLen), snippet) <= maxDistance) {
      return i;
    }
  }
  return -1;
}
// ---------------------------------------------------------------------------