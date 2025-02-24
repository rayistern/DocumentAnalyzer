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

export async function processFile(content, type, filepath, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength, overview = '', skipMetadata = false, isContinuation = false, contentHash = null, previousText = '') {
    try {
        let result;
        switch (type) {
            case 'sentiment':
                result = await analyzeSentiment(content);
                break;
            case 'chunk':
                result = await createChunks(content, maxChunkLength, filepath);
                break;
            case 'cleanAndChunk':
                result = await cleanAndChunkDocument(content, maxChunkLength, filepath, overview, skipMetadata, isContinuation, contentHash, previousText);
                break;
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
                
                result = metadata;
                break;
            default:
                result = await summarizeContent(content);
        }
        return result;
    } catch (error) {
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

function cleanText(text, textToRemove) {
    // Normalize quotation marks in the input text
    const normalizeQuotes = (str) => {
        const normalized = str.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // Various double quotes
                             .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")   // Various single quotes
                             .replace(/[""]/g, '"')
                             .replace(/['']/g, "'");
        return normalized;
    };
    let cleanedText = normalizeQuotes(text);
    const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;
    let offset = 0;  // Track how many characters we've removed

    if (textToRemove && Array.isArray(textToRemove)) {
        textToRemove.forEach(item => {
            const normalizedItemText = normalizeQuotes(item.text);
            let found = false;

            // Try fuzzy boundary matching first
            const adjustedStart = item.startPosition - 1 - offset;
            const fuzzyPos = findCompleteBoundary(cleanedText, adjustedStart, normalizedItemText);
            if (fuzzyPos !== adjustedStart) {
                found = true;
                cleanedText = cleanedText.substring(0, fuzzyPos) + 
                            cleanedText.substring(fuzzyPos + normalizedItemText.length);
                offset += normalizedItemText.length;
                console.log(`Removed text by fuzzy boundary match: "${normalizedItemText}"`);
            }

            // If fuzzy boundary fails, try other methods
            if (!found) {
                // Normalize the text to remove
                const normalizedItemText = normalizeQuotes(item.text);
                
                // IMPORTANT: First try the exact position the LLM gave us
                // Only fall back to searching if that fails
                let found = false;

                // Adjust positions based on how much text we've removed so far
                const adjustedStart = item.startPosition - 1 - offset;
                const adjustedEnd = item.endPosition - offset;

                // Try exact position first
                const exactText = cleanedText.substring(adjustedStart, adjustedEnd);
                if (exactText === normalizedItemText) {
                    found = true;
                    cleanedText = cleanedText.substring(0, adjustedStart) + 
                                cleanedText.substring(adjustedEnd);
                    offset += normalizedItemText.length;
                    console.log(`Removed text at exact position: "${normalizedItemText}"`);
                }

                // If exact position fails, search near the position
                if (!found) {
                    const searchStart = Math.max(0, adjustedStart - tolerance);
                    const searchEnd = Math.min(cleanedText.length, adjustedEnd + tolerance);
                    const searchArea = cleanedText.substring(searchStart, searchEnd);
                    
                    const textPos = searchArea.indexOf(normalizedItemText);
                    if (textPos !== -1) {
                        found = true;
                        cleanedText = cleanedText.substring(0, searchStart + textPos) + 
                                    cleanedText.substring(searchStart + textPos + normalizedItemText.length);
                        offset += normalizedItemText.length;
                        console.log(`Removed text by position-guided search: "${normalizedItemText}"`);
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

async function cleanAndChunkDocument(content, maxChunkLength, filepath, overview = '', skipMetadata = false, isContinuation = false, contentHash = null, previousText = '') {
    console.log('Starting clean and chunk process...');
    
    // Log previous text info if this is a continuation
    if (isContinuation && previousText) {
        console.log('\n=== Continuation Info ===');
        console.log(`Previous text length: ${previousText.length}`);
        console.log(`Preview: "${previousText.slice(0, 100)}..."`);
    } else {
        console.log('No previous text to prepend');
        isContinuation = false;
    }

    // Save initial document with the raw content hash
    const document = await saveAnalysis(content, skipMetadata ? 'cleanAndChunk' : 'fullMetadata_only', { 
        filepath,
        content_hash: contentHash
    });
    console.log('Saved document with ID:', document.id);

    // Pre-chunk the text
    const preChunks = preChunkText(content, OPENAI_SETTINGS.preChunkSize);
    console.log(`Created ${preChunks.length} pre-chunks`);

    let cleanedChunks = [];
    let allTextToRemove = [];
    let remainderText = '';
    let finalCleanedText = '';

    // Process each pre-chunk
    for (let i = 0; i < preChunks.length; i++) {
        console.log(`\n=== Processing pre-chunk ${i + 1}/${preChunks.length} ===`);
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
        let finalChunkText = cleanedText;
        
        // If this is the first chunk and we have previous text, prepend it
        if (i === 0 && previousText && isContinuation) {  // Only prepend if we're still treating as continuation
            console.log('\nPrepending previous text:');
            console.log(`- Text length before prepend: ${finalChunkText.length}`);
            console.log(`- Previous text length: ${previousText.length}`);
            console.log(`- Previous text preview: "${previousText.slice(0, 100)}..."`);
            finalChunkText = previousText + '\n' + cleanedText;
            console.log(`- Text length after prepend: ${finalChunkText.length}`);
            console.log('Prepended previous document context');
        }

        finalCleanedText += finalChunkText;  // Accumulate cleaned text
        console.log(`Cleaned text length: ${finalChunkText.length}`);
        console.log('First 100 chars of cleaned text:', finalChunkText.substring(0, 100));

        // Update document with current cleaned text
        await saveCleanedDocument(document.id, finalCleanedText, content, OPENAI_SETTINGS.model);

        // Get metadata for the cleaned text
        if (!skipMetadata) {
            console.log('\nGetting metadata for cleaned text...');
            try {
                const metadataResponse = await openai.chat.completions.create(
                    createApiOptions(getModelForOperation('fullMetadata'), [
                        OPENAI_PROMPTS.cleanAndChunk.fullMetadata(),
                        {
                            role: "user",
                            content: cleanedText
                        }
                    ])
                );
                console.log('Full metadata operation used model:', metadataResponse.model);
                
                // Store raw response first
                const { error: rawError } = await supabase
                    .from('documents')
                    .update({ 
                        raw_llm_response: metadataResponse.choices[0].message.content,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', document.id);

                if (rawError) {
                    console.error('Error storing raw response:', rawError);
                }
                
                // Continue with normal metadata processing
                const cleanedResponse = removeMarkdownFormatting(metadataResponse.choices[0].message.content);
                console.log('Attempting to parse metadata JSON:', cleanedResponse);
                const metadata = parseJsonResponse(cleanedResponse);
                
                // Store processed metadata
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
                    // Update document source status to processed
                    const { error: statusError } = await supabase
                        .from('document_sources')
                        .update({ 
                            status: 'processed',
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', document.document_source_id);

                    if (statusError) {
                        console.error(`Error updating status for document ${document.id}:`, statusError);
                    } else {
                        console.log('Saved metadata to document');
                    }
                }
            } catch (error) {
                console.error('Error in metadata generation/saving:', error);
                console.error('Full error:', error.stack);
            }
        }

        // Send cleaned text to LLM for semantic chunking
        console.log('Sending text to LLM for chunking...');
        
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
        console.log('Raw response:', chunkResponse.choices[0].message.content);
        let parsedResponse;
        try {
            parsedResponse = parseJsonResponse(removeMarkdownFormatting(chunkResponse.choices[0].message.content));
            console.log('Parsed response:', JSON.stringify(parsedResponse, null, 2));
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
            // Validate chunks have required fields
            chunkResult.chunks = chunkResult.chunks.filter(chunk => {
                if (!chunk.cleanedText) {
                    console.warn('Chunk missing cleanedText:', chunk);
                    return false;
                }
                return true;
            });
            
            // Get remainder text for next iteration
            const lastChunk = chunkResult.chunks[chunkResult.chunks.length - 1];
            remainderText = cleanedText.substring(lastChunk.endIndex);
            
            console.log('\n=== Remainder Info ===');
            console.log(`Total text length: ${cleanedText.length}`);
            console.log(`Last chunk ends at: ${lastChunk.endIndex}`);
            console.log(`Remainder length: ${remainderText.length}`);
            if (remainderText.length > 0) {
                console.log(`Remainder preview: "${remainderText.slice(0, 100)}..."`);
            }

            // Accumulate processed chunks
            cleanedChunks = [...cleanedChunks, ...chunkResult.chunks];
            console.log(`Total chunks so far: ${cleanedChunks.length}`);
            
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
            startIndex: content.length - remainderText.length + 1,
            endIndex: content.length,
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
            
            // Skip metadata for last chunk only if ALL conditions are met:
            // 1. There's no remainder text AND
            // 2. There are more documents in the queue AND
            // 3. This is a continuation document
            if (isLastChunk && !remainderText.trim() && isContinuation) {
                // Check if this is the last file in the queue
                const { data: nextFile, error: fileError } = await supabase
                    .from('document_sources')
                    .select('id')
                    .gt('created_at', new Date().toISOString())
                    .limit(1);
                
                if (!fileError && nextFile?.length > 0) {
                    console.log('Skipping metadata for last chunk - no remainder, more documents in queue, and is continuation');
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
    let textForNextDocument = '';
    if (remainderText.trim()) {
        console.log('\n=== Text for Next Document ===');
        console.log(`Using remainder text of length ${remainderText.length}`);
        textForNextDocument = remainderText.trim();
    } else if (cleanedChunks.length > 0) {
        const lastChunk = cleanedChunks[cleanedChunks.length - 1];
        console.log('\n=== Text for Next Document ===');
        console.log('Using last chunk as no remainder exists');
        textForNextDocument = lastChunk.cleanedText;
    }
    
    if (textForNextDocument) {
        console.log(`Preview of text for next doc: "${textForNextDocument.slice(0, 100)}..."`);
    }

    return {
        textToRemove: allTextToRemove,
        chunks: cleanedChunks,
        warnings,
        textForNextDocument
    };
}

async function generateMetadata(chunk) {
    if (!chunk || !chunk.cleanedText) {
        console.error('Invalid chunk or missing cleanedText:', chunk);
        throw new Error('Cannot generate metadata: chunk has no cleaned text');
    }
    console.log('\n=== Chunk Content for Metadata ===');
    console.log('Chunk length:', chunk.cleanedText.length);
    console.log('First 100 chars:', chunk.cleanedText.substring(0, 100));
    
    return retryWithFallback(async (model) => {
        console.log(`\nAttempting metadata generation with model: ${model}`);
        const response = await openai.chat.completions.create(
            createApiOptions(model, [
                OPENAI_PROMPTS.metadata(),
                { role: "user", content: chunk.cleanedText }
            ])
        );
        console.log(`Successfully used model: ${response.model}`);
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