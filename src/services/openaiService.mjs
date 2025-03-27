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
export async function processFile(content, type, filepath, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength, overview = '', skipMetadata = false, isContinuation = false, groupNumber = null, previousDocumentId = null, inMemoryRemainderText = null) {
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
                return await cleanAndChunkDocument(content, maxChunkLength, filepath, overview, skipMetadata, isContinuation, groupNumber, previousDocumentId, inMemoryRemainderText);
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
    /**
     * NOTE: This function has a potentially problematic workflow compared to cleanAndChunkDocument:
     * 
     * 1. It sends raw, uncleaned text directly to the LLM for chunking
     * 2. The LLM returns indices based on this uncleaned text
     * 3. Only afterward does it try to clean each chunk individually
     * 
     * This is different from the preferred workflow in cleanAndChunkDocument which:
     * 1. Pre-chunks the text into manageable pieces
     * 2. Cleans each pre-chunk first (removes headers, footers)
     * 3. Prepends remainder text from previous iterations
     * 4. Then sends the clean text to the LLM for semantic chunking
     * 
     * If this function is used, chunk boundaries may not align with semantic 
     * boundaries after cleaning because they were determined on uncleaned text.
     */
    try {
        const response = await openai.chat.completions.create(
            createApiOptions(getModelForOperation('chunk'), [
                {
                    role: OPENAI_PROMPTS.chunk.role,
                    content: OPENAI_PROMPTS.chunk.content(maxChunkLength)
                },
                {
                    role: "user",
                    content: text // Raw text sent to LLM, no cleaning applied
                }
            ])
        );

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);

        const cleanResponse = removeMarkdownFormatting(response.choices[0].message.content);
        // text parameter passed here must match exactly what was sent to LLM for indices to align
        const result = parseJsonResponse(cleanResponse, text, 'chunk');

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
    // Strip diacritics from both search text and word
    const searchText = stripDiacritics(normalizeQuotes(text.substring(start, end)));
    const normalizedWord = stripDiacritics(normalizeQuotes(word));
    
    const wordIndex = searchText.indexOf(normalizedWord);
    if (wordIndex !== -1) {
        return start + wordIndex;
    }
    
    return position;
}

/**
 * Finds the actual position of a word in text, with sophisticated matching
 * 
 * This function is critical for accurate chunk boundary detection. When the LLM 
 * provides positions, they may not exactly match the actual text. This function:
 * 1. Tries exact matches first within a tolerance range
 * 2. Falls back to fuzzy matching for similar words 
 * 3. Uses different strategies for start vs. end positions
 * 4. Ensures positions are valid and within text bounds
 * 
 * IMPORTANT: Works on the finalCleanedText which already includes the remainder text,
 * so all positions automatically account for remainder length.
 * 
 * @param {string} text - The text to search in (complete text with remainder prepended)
 * @param {string} targetWord - The word to find 
 * @param {number} nearPosition - Approximate position where word should be
 * @param {boolean} isStart - Whether this is a start position (vs. end)
 * @param {number} previousChunkEnd - Position of previous chunk end, if any
 * @returns {number} The best position found for the word
 */
function findWordPosition(text, targetWord, nearPosition, isStart, previousChunkEnd = 0) {
    // Safety check inputs
    if (!targetWord || targetWord.length === 0) {
        console.log(`Warning: Empty target word provided`);
        return isStart ? previousChunkEnd : nearPosition;
    }
    
    // Ensure nearPosition is within text bounds
    console.log(`\nfindWordPosition input values:`);
    console.log(`- Target word: "${targetWord}"`);
    console.log(`- Original nearPosition: ${nearPosition}`);
    console.log(`- Text length: ${text.length}`);
    console.log(`- Previous chunk end: ${previousChunkEnd}`);
    
    const origNearPosition = nearPosition;  // Store original for logging
    nearPosition = Math.min(Math.max(0, nearPosition), text.length);
    if (nearPosition !== origNearPosition) {
        console.log(`- nearPosition adjusted to: ${nearPosition} (was: ${origNearPosition})`);
    }
    
    // Normalize the target word - remove diacritics and standardize punctuation
    const normalizeText = (str) => {
        return str.normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')  // Remove diacritics
            .replace(/[.,;:!?'"—–-]/g, ' ')    // Replace punctuation with spaces
            .replace(/\s+/g, ' ')              // Normalize spaces
            .trim();
    };
    
    const normalizedTargetWord = normalizeText(targetWord);
    console.log(`- Normalized target word: "${normalizedTargetWord}"`);
    
    // Define search range with tolerance
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
    console.log(`- Search area length: ${searchArea.length}`);
    
    // Try exact match first
    const exactIndex = searchArea.indexOf(targetWord);
    if (exactIndex !== -1) {
        const foundPosition = searchStart + exactIndex;
        console.log(`Found exact match "${targetWord}" at position ${foundPosition}`);
        return foundPosition;
    }
    console.log(`- No exact match found`);
    
    // Try searching for normalized version within normal tolerance first
    console.log(`Trying normalized match within normal tolerance...`);
    const words = searchArea.split(/\s+/);
    let bestMatch = findBestMatch(words, normalizedTargetWord, searchArea, searchStart);
    
    if (bestMatch.position !== -1) {
        console.log(`Found normalized match "${bestMatch.word}" for target "${targetWord}" at position ${bestMatch.position}`);
        return bestMatch.position;
    }

    // Try searching in a wider area if first search failed
    const widerStart = Math.max(0, nearPosition - tolerance * 2);
    const widerEnd = Math.min(text.length, nearPosition + tolerance * 2);
    const widerArea = text.substring(widerStart, widerEnd);
    console.log(`\nTrying wider search: ${widerStart}-${widerEnd}`);
    
    // Try fuzzy matching within wider area
    const widerWords = widerArea.split(/\s+/);
    bestMatch = findBestMatch(widerWords, normalizedTargetWord, widerArea, widerStart);
    
    if (bestMatch.position !== -1) {
        console.log(`Found fuzzy match "${bestMatch.word}" for target "${targetWord}" at position ${bestMatch.position}`);
        return bestMatch.position;
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
async function cleanAndChunkDocument(content, maxChunkLength, filepath, overview = '', skipMetadata = false, isContinuation = false, groupNumber = null, previousDocumentId = null, inMemoryRemainderText = null) {
    console.log('\n=== Starting Document Processing ===');
    console.log(`Total document length: ${content.length} characters`);
    console.log(`Continuation mode: ${isContinuation ? 'ON' : 'OFF'}`);
    console.log(`Group number: ${groupNumber || 'none'}`);

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
            
            const { error: prechunkError } = await supabase
                .from('prechunks')
                .insert(prechunkData);

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
                OPENAI_PROMPTS.cleanAndChunk.clean('', true), // Always set isIncomplete=true for continuations
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
            cleanResult = parseJsonResponse(cleanResponse.choices[0].message.content, 'textRemoval');
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
            parsedResponse = parseJsonResponse(removeMarkdownFormatting(rawChunkResponse), finalCleanedText, 'chunk');
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
                for (const chunk of parsedResponse.chunks) {
                    // Always extract text based on positions
                    if (chunk.startIndex !== undefined && chunk.endIndex !== undefined) {
                        const start = Math.max(0, chunk.startIndex - 1); // 0-indexed positions
                        const end = Math.min(finalCleanedText.length, chunk.endIndex);
                        
                        if (start < end && end <= finalCleanedText.length) {
                            chunk.cleanedText = finalCleanedText.substring(start, end);
                            console.log(`Extracted text for position ${start+1}-${end}, length=${chunk.cleanedText.length}`);
                            console.log(`Text sample: "${chunk.cleanedText.substring(0, Math.min(50, chunk.cleanedText.length))}..."`);
                            
                            // Map boundary phrases
                            if (chunk.firstWords) chunk.firstWord = chunk.firstWords;
                            if (chunk.lastWords) chunk.lastWord = chunk.lastWords;
                        } else {
                            console.error(`Invalid position range: ${start+1}-${end}`);
                            chunk.cleanedText = '';
                        }
                    } else {
                        console.error(`Missing position information for chunk`);
                        chunk.cleanedText = '';
                    }
                }
            }
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
            
            /**
             * POSITION ADJUSTMENT LOGIC
             * 
             * 1. The LLM returns positions relative to the text it received (finalCleanedText)
             * 2. The finalCleanedText already includes remainder text at the beginning
             * 3. Within each prechunk, we track position drift with cumulativeOffset
             * 4. Each prechunk resets cumulativeOffset because each is a separate LLM call
             * 
             * This approach ensures:
             * - Remainder text length is automatically accounted for (it's part of finalCleanedText)
             * - Position drift within a single LLM response is tracked and corrected
             * - Word boundaries are accurately detected even with Unicode/special characters
             */
            let cumulativeOffset = 0;  // Resets for each prechunk's LLM call
            let previousAdjustedEnd = 0;  // Tracks last chunk's end position
            
            parsedResponse.chunks = parsedResponse.chunks.map((chunk, index) => {
                console.log(`\nChunk ${index + 1}:`);
                console.log(`Original: Start: ${chunk.startIndex}, End: ${chunk.endIndex}`);
                
                /**
                 * STEP 1: OFFSET ADJUSTMENT
                 * 
                 * Apply cumulative offset from previous chunks in this prechunk.
                 * This accounts for any drift between where the LLM thinks positions are
                 * and where they actually are (often due to Unicode handling differences).
                 * 
                 * NOTE: The LLM's position numbers already account for remainder text
                 * because remainder is prepended to the text before sending to the LLM.
                 */
                const offsetAdjustedStartIndex = chunk.startIndex + cumulativeOffset - 1; // Convert to 0-indexed
                const offsetAdjustedEndIndex = chunk.endIndex + cumulativeOffset - 1;  // Convert to 0-indexed
                
                console.log(`After offset adjustment: Start: ${offsetAdjustedStartIndex+1}, End: ${offsetAdjustedEndIndex+1}`);
                
                // Extract first and last words for boundary detection
                if (chunk.cleanedText && chunk.cleanedText.trim().length > 0) {
                    // Get words from the cleanedText
                    const words = chunk.cleanedText.trim().split(/\s+/);
                    
                    // Use firstWords/lastWords from LLM if available, otherwise extract from cleanedText
                    if (chunk.firstWords) {
                        chunk.firstWord = chunk.firstWords;
                        console.log(`Using LLM-provided firstWords: "${chunk.firstWord}"`);
                    } else {
                    // Extract 3-4 word phrases for more robust boundary detection
                    const startPhraseLength = Math.min(4, Math.ceil(words.length / 4), words.length);
                    chunk.firstWord = words.slice(0, startPhraseLength).join(' ');
                        console.log(`Generated firstWord phrase: "${chunk.firstWord}"`);
                    }
                    
                    if (chunk.lastWords) {
                        chunk.lastWord = chunk.lastWords;
                        console.log(`Using LLM-provided lastWords: "${chunk.lastWord}"`);
                    } else {
                    // For the end phrase, take the last 3-4 words (or fewer if not available)
                    const endPhraseLength = Math.min(4, Math.ceil(words.length / 4), words.length);
                    chunk.lastWord = words.slice(-endPhraseLength).join(' ');
                        console.log(`Generated lastWord phrase: "${chunk.lastWord}"`);
                    }
                    
                    console.log(`Boundary phrases detected:`);
                    console.log(`- First phrase: "${chunk.firstWord}"`);
                    console.log(`- Last phrase: "${chunk.lastWord}"`);
                }
                
                // Use the word boundary detection to get accurate positions
                if (chunk.firstWord && chunk.lastWord) {
                    // Use offset-adjusted positions as the starting point for word search
                    const suggestedStartIndex = offsetAdjustedStartIndex;
                    const suggestedEndIndex = offsetAdjustedEndIndex;
                    
                    console.log(`\n======== WORD BOUNDARY DETECTION - CHUNK ${index + 1} ========`);
                    console.log(`Finding exact word boundaries for precise chunking:`);
                    console.log(`- First word to find: "${chunk.firstWord}"`);
                    console.log(`- Last word to find: "${chunk.lastWord}"`);
                    console.log(`- Starting search at positions: ${suggestedStartIndex+1}-${suggestedEndIndex+1}`);
                    
                    /**
                     * STEP 2: WORD BOUNDARY DETECTION
                     * 
                     * Find exact word boundaries to ensure chunks break at natural points.
                     * This is crucial for proper text extraction and avoiding broken words.
                     * The findWordPosition function does fuzzy matching to handle cases
                     * where exact matches aren't found.
                     */
                    // Adjust positions based on actual word locations
                    const adjustedStartIndex = findWordPosition(
                        finalCleanedText, 
                        chunk.firstWord, 
                        suggestedStartIndex, 
                        true, 
                        previousAdjustedEnd
                    );
                    
                    const adjustedEndIndex = findWordPosition(
                        finalCleanedText, 
                        chunk.lastWord, 
                        suggestedEndIndex, 
                        false, 
                        adjustedStartIndex
                    );
                    
                    // Update with adjusted positions (convert back to 1-indexed)
                    chunk.adjustedStartIndex = adjustedStartIndex + 1;
                    chunk.adjustedEndIndex = adjustedEndIndex + 1;
                    previousAdjustedEnd = adjustedEndIndex;
                    
                    // Track additional metrics for database storage
                    chunk.within_tolerance = Math.abs(adjustedStartIndex - suggestedStartIndex) <= tolerance && 
                                             Math.abs(adjustedEndIndex - suggestedEndIndex) <= tolerance;
                    chunk.position_difference = adjustedEndIndex - suggestedEndIndex;
                    chunk.llm_suggested_end = chunk.endIndex;
                    chunk.actual_end = chunk.adjustedEndIndex;
                    chunk.first_word_match = adjustedStartIndex === suggestedStartIndex;
                    chunk.last_word_match = adjustedEndIndex === suggestedEndIndex;
                    
                    console.log(`\nWORD BOUNDARY RESULTS:`);
                    console.log(`- Original positions: ${chunk.startIndex}-${chunk.endIndex}`);
                    console.log(`- Final adjusted positions: ${chunk.adjustedStartIndex}-${chunk.adjustedEndIndex}`);
                    console.log(`- Position change: start ${chunk.adjustedStartIndex - chunk.startIndex}, end ${chunk.adjustedEndIndex - chunk.endIndex}`);
                    console.log(`======== END WORD BOUNDARY DETECTION ========\n`);
                    
                    /**
                     * STEP 3: CUMULATIVE OFFSET CALCULATION
                     * 
                     * Calculate how far the actual end position (adjustedEndIndex) differs 
                     * from where the LLM thought it was (chunk.endIndex-1). This "drift"
                     * is applied to future chunks in this prechunk, not the current one.
                     */
                    const newOffset = adjustedEndIndex - (chunk.endIndex - 1);  // Compare to original end position
                    console.log(`Position drift: ${newOffset} characters from LLM's calculation (will be applied to future chunks)`);
                    cumulativeOffset = newOffset;  // Update for next chunk
                    
                    /**
                     * STEP 4: TEXT RE-EXTRACTION
                     * 
                     * Now that we have final adjusted positions, we re-extract the text
                     * to ensure we have accurate text content that aligns with word boundaries.
                     */
                    // If positions were adjusted, re-extract the text
                    if (adjustedStartIndex !== suggestedStartIndex || adjustedEndIndex !== suggestedEndIndex) {
                        console.log(`Positions adjusted: ${suggestedStartIndex+1}-${suggestedEndIndex+1} -> ${chunk.adjustedStartIndex}-${chunk.adjustedEndIndex}`);
                        
                        // Re-extract the text with adjusted positions
                        if (adjustedStartIndex < adjustedEndIndex && adjustedEndIndex <= finalCleanedText.length) {
                            chunk.cleanedText = finalCleanedText.substring(adjustedStartIndex, adjustedEndIndex);
                            console.log(`Re-extracted text with adjusted boundaries`);
                        }
                    }
                } else if (!chunk.cleanedText && chunk.startIndex && chunk.endIndex) {
                    // If no cleanedText but position info exists
                    // Fix positions if needed to ensure valid extraction
                    console.log(`\n⚠️ CHUNK HAS POSITIONS BUT NO TEXT - attempting to extract text from positions`);
                    
                    // Validate positions are within bounds
                    // Use the adjusted positions instead of the original positions
                    const start = Math.max(0, offsetAdjustedStartIndex); // Already 0-indexed
                    const end = Math.min(finalCleanedText.length, offsetAdjustedEndIndex);
                    
                    console.log(`Extracting text from positions: ${start} to ${end} (length: ${end-start})`);
                    console.log(`finalCleanedText length: ${finalCleanedText.length}`);
                    
                    if (start >= end) {
                        console.error(`❌ Invalid position range: start(${start}) >= end(${end})`);
                        chunk.cleanedText = ''; // Empty string to avoid null/undefined
                    } else if (start < 0 || end > finalCleanedText.length) {
                        console.error(`❌ Out of bounds position: start(${start}), end(${end}), text length(${finalCleanedText.length})`);
                        chunk.cleanedText = ''; // Empty string to avoid null/undefined
                    } else {
                        // Extract text using positions
                        chunk.cleanedText = finalCleanedText.substring(start, end);
                        
                        // Check if we got valid text (not just whitespace)
                        if (chunk.cleanedText.trim().length > 0) {
                            console.log(`✅ Successfully extracted text (${chunk.cleanedText.length} chars)`);
                            console.log(`Text sample: "${chunk.cleanedText.substring(0, Math.min(50, chunk.cleanedText.length))}..."`);
                            
                            // Extract first/last words
                            const words = chunk.cleanedText.trim().split(/\s+/).filter(w => w.length > 0);
                            chunk.firstWord = words.length > 0 ? words[0] : '';
                            chunk.lastWord = words.length > 0 ? words[words.length - 1] : '';
                            console.log(`Words detected - First: "${chunk.firstWord}", Last: "${chunk.lastWord}"`);
                        } else {
                            // Just use the text even if it's whitespace - don't filter it out here
                            console.log(`⚠️ WARNING: Extracted text contains only whitespace`);
                            console.log(`Raw text (hex): ${Array.from(chunk.cleanedText).map(c => c.charCodeAt(0).toString(16)).join(' ')}`);
                            
                            // Still set first/last word for debugging purposes
                            chunk.firstWord = '';
                            chunk.lastWord = '';
                        }
                    }
                } else if (!chunk.cleanedText) {
                    console.error(`❌ Cannot extract text - chunk has no cleanedText and insufficient position data`);
                    chunk.cleanedText = ''; // Empty string to avoid null/undefined
                }
                
                console.log(`Final text: ${chunk.cleanedText ? chunk.cleanedText.substring(0, 30) + "..." : "No text provided"}`);
                return chunk;
            });
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
                    last_word_match: chunk.last_word_match || false
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
                    
                    // Process chunks sequentially to avoid out-of-order issues
                    for (let i = 0; i < chunksToSave.length; i++) {
                        const chunk = chunksToSave[i];
                        console.log(`\n----- Processing metadata for chunk ${i+1}/${chunksToSave.length} -----`);
                        
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
                                    continue;
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
                        
                        // Add a small delay between API calls to avoid rate limiting
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        console.log(`----- Completed processing for chunk ${i+1}/${chunksToSave.length} -----`);
                    }
                    
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