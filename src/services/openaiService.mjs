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

async function cleanAndChunkDocument(content, maxChunkLength, filepath, overview = '', skipMetadata = false, isContinuation = false, contentHash = null) {
    console.log('\n=== Starting Document Processing ===');
    console.log(`Total document length: ${content.length} characters`);
    console.log(`Max chunk length: ${maxChunkLength} characters`);
    // Debug: Show beginning and end of content
    console.log(`\nFirst 100 characters of document content:`);
    console.log(`"${content.substring(0, 100)}..."`);
    console.log(`\nLast 100 characters of document content:`);
    console.log(`"...${content.substring(content.length - 100)}"`);
    console.log('=====================================\n');
    
    // Generate a content hash if not provided
    if (!contentHash) {
        contentHash = generateHash(content);
    }
    
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

// Combine remainder with current chunk
const chunk = preChunks[i];
console.log(`\n==== DEBUGGING REMAINDER INCLUSION ====`);
if (remainderText.length > 0) {
    console.log(`Remainder (${remainderText.length} chars):`);
    console.log(`- Start: "${remainderText.substring(0, 50)}..."`);
    console.log(`- End: "...${remainderText.substring(remainderText.length - 50)}"`);
} else {
    console.log(`No remainder from previous iteration`);
}
console.log(`Current chunk (${chunk.text.length} chars):`);
console.log(`- Start: "${chunk.text.substring(0, 50)}..."`);

const combinedText = remainderText + chunk.text;
console.log(`Combined text (${combinedText.length} chars):`);
console.log(`- Start: "${combinedText.substring(0, 50)}..."`);
console.log(`==== END DEBUGGING ====\n`);

console.log(`[1] Remainder text (${remainderText.length} chars): "${remainderText.slice(0, 40)}${remainderText.length > 40 ? '...' : ''}"`);
console.log(`[2] Combined text (${combinedText.length} chars): "${combinedText.slice(0, 40)}${combinedText.length > 40 ? '...' : ''}"`);
console.log(`Combined text length: ${combinedText.length} (${remainderText.length} from remainder)`);