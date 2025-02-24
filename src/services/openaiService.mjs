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
        console.log('\n=== Processing File ===');
        console.log('Type:', type);
        console.log('Filepath:', filepath);
        console.log('Content Hash:', contentHash);
        console.log('Content Length:', content?.length || 0);
        console.log('=====================\n');

        switch (type) {
            case 'sentiment':
                return await analyzeSentiment(content);
            case 'chunk':
                return await createChunks(content, maxChunkLength, filepath);
            case 'cleanAndChunk':
                return await cleanAndChunkDocument(content, maxChunkLength, filepath, overview, skipMetadata, isContinuation, contentHash);
            case 'fullMetadata_only':
                // Save initial document
                console.log('Content hash for deduplication:', contentHash);
                
                // Check for existing document with this hash
                const { data: existingDoc, error: hashSearchError } = await supabase
                    .from('documents')
                    .select('id, filepath')
                    .eq('content_hash', contentHash)
                    .single();
                    
                if (hashSearchError) {
                    console.log('No existing document found with hash:', contentHash);
                } else {
                    console.log('Found existing document:', existingDoc);
                }
                
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

function cleanText(text, textToRemove) {
    // Enhanced quote normalization with validation
    const normalizeQuotes = (str) => {
        const normalized = str
            .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // Various double quotes
            .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")   // Various single quotes
            .replace(/[\u05F4\u05F3]/g, '"')  // Hebrew quotes
            .replace(/[\u05BE]/g, '-')        // Hebrew hyphen
            .replace(/[\u05C3]/g, '.')        // Hebrew period
            .replace(/[""]/g, '"')
            .replace(/['']/g, "'")
            // Remove Hebrew diacritics
            .replace(/[\u0591-\u05C7\u05B0-\u05BB\u05BC\u05BD\u05BF\u05C1\u05C2]/g, '')
            .replace(/\s+/g, ' ');
        
        // Validate no quotes were accidentally converted to spaces
        const beforeQuoteCount = (str.match(/[""'']/g) || []).length;
        const afterQuoteCount = (normalized.match(/["']/g) || []).length;
        if (beforeQuoteCount > afterQuoteCount) {
            console.warn(`Warning: Quote normalization may have lost quotes. Before: ${beforeQuoteCount}, After: ${afterQuoteCount}`);
            console.warn('Original text:', str);
            console.warn('Normalized text:', normalized);
        }
        
        return normalized.trim();
    };

    let cleanedText = normalizeQuotes(text);
    const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;
    let offset = 0;  // Track how many characters we've removed

    if (textToRemove && Array.isArray(textToRemove)) {
        textToRemove.forEach(item => {
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
    
    chunks.forEach((chunk, index) => {
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

async function cleanAndChunkDocument(content, maxChunkLength, filepath, overview = '', skipMetadata = false, isContinuation = false, contentHash = null) {
    console.log('Starting clean and chunk process...');
    
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
                console.log('Remainder text:', previousText.substring(0, 100) + '...');
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
                    console.log('Last chunk text:', previousText.substring(0, 100) + '...');
                }
            }
        }
    }
    
    // Save initial document with the raw content hash
    console.log('\n=== Document Processing ===');
    console.log('Content hash for deduplication:', contentHash);
    console.log('Original content length:', content.length);
    console.log('Previous text length:', previousText.length);
    console.log('========================\n');
    
    // Check for existing document with this hash
    const { data: existingDoc, error: hashSearchError } = await supabase
        .from('documents')
        .select('id, filepath')
        .eq('content_hash', contentHash)
        .single();
        
    if (hashSearchError) {
        console.log('No existing document found with hash:', contentHash);
    } else {
        console.log('Found existing document:', existingDoc);
    }
    
    const document = await saveAnalysis(content, skipMetadata ? 'cleanAndChunk' : 'fullMetadata_only', { 
        filepath,
        content_hash: contentHash
    });
    console.log('Saved original document with ID:', document.id);

    // Clean the text first
    console.log('\n=== Text Cleaning ===');
    const cleanResponse = await openai.chat.completions.create(
        createApiOptions(getModelForOperation('clean'), [
            OPENAI_PROMPTS.cleanAndChunk.clean('', true),
            {
                role: "user",
                content: content
            }
        ])
    );

    console.log('Clean response received');
    await logLLMResponse(null, cleanResponse.choices[0].message.content, OPENAI_SETTINGS.model);
    let cleanResult;
    try {
        cleanResult = parseJsonResponse(cleanResponse.choices[0].message.content);
        console.log('Found', cleanResult.textToRemove?.length || 0, 'items to remove');
    } catch (parseError) {
        console.warn('Failed to parse LLM response as JSON:', parseError.message);
        cleanResult = { textToRemove: [] };
    }

    // Clean the text using our enhanced Hebrew-aware cleaner
    console.log('\nApplying text cleaning...');
    const cleanedText = cleanText(content, cleanResult.textToRemove);
    console.log('Text cleaning complete');
    console.log('Original length:', content.length);
    console.log('Cleaned length:', cleanedText.length);
    console.log('Difference:', content.length - cleanedText.length, 'characters');
    
    // Combine with previous text if available
    console.log('\n=== Text Combination ===');
    const fullText = previousText ? previousText + '\n' + cleanedText : cleanedText;
    console.log('Text preparation:');
    console.log('Previous text length:', previousText.length);
    console.log('Cleaned text length:', cleanedText.length);
    console.log('Combined text length:', fullText.length);
    console.log('First 100 chars:', fullText.substring(0, 100) + '...');
    console.log('Last 100 chars:', fullText.substring(fullText.length - 100) + '...');

    // Update document with cleaned text
    await saveCleanedDocument(document.id, cleanedText, content, OPENAI_SETTINGS.model);

    // Get metadata if needed
    if (!skipMetadata) {
        console.log('\n=== Metadata Generation ===');
        try {
            const metadataResponse = await openai.chat.completions.create(
                createApiOptions(getModelForOperation('fullMetadata'), [
                    OPENAI_PROMPTS.cleanAndChunk.fullMetadata(),
                    {
                        role: "user",
                        content: fullText
                    }
                ])
            );
            
            console.log('Metadata response received');
            const cleanedResponse = removeMarkdownFormatting(metadataResponse.choices[0].message.content);
            const metadata = parseJsonResponse(cleanedResponse);
            console.log('Metadata parsed successfully');
            
            await supabase
                .from('documents')
                .update({ 
                    raw_llm_response: metadataResponse.choices[0].message.content,
                    long_description: metadata.longDescription,
                    keywords: metadata.keywords,
                    questions_answered: metadata.questionsAnswered,
                    updated_at: new Date().toISOString()
                })
                .eq('id', document.id);
            console.log('Metadata saved to database');
        } catch (error) {
            console.error('Error in metadata generation:', error);
            console.error('Full error:', error.stack);
        }
    }

    // Now get the chunks using the full text
    console.log('\n=== Chunking Process ===');
    console.log('Sending text to LLM for chunking...');
    console.log('Text length:', fullText.length);
    console.log('Max chunk length:', maxChunkLength);
    
    const response = await openai.chat.completions.create(
        createApiOptions(getModelForOperation('chunk'), [
            OPENAI_PROMPTS.cleanAndChunk.chunk(maxChunkLength),
            {
                role: "user",
                content: fullText
            }
        ])
    );

    console.log('Chunk response received');
    const result = parseJsonResponse(removeMarkdownFormatting(response.choices[0].message.content));
    console.log('Number of chunks:', result.chunks?.length || 0);
    
    if (result.chunks) {
        console.log('\nProcessing chunks...');
        result.chunks = result.chunks.map((chunk, index) => {
            // Check if we need to force start after previous chunk
            let startIndex = chunk.startIndex;
            let endIndex = chunk.endIndex;
            
            if (index > 0) {
                const gap = startIndex - (result.chunks[index - 1].endIndex + 1);
                if (gap > OPENAI_SETTINGS.gapConfig.maxTolerance) {
                    startIndex = result.chunks[index - 1].endIndex + 1;
                    console.log(`Gap of ${gap} exceeds tolerance. Forcing chunk to start at ${startIndex}`);
                }
            }
            
            // Debug output
            console.log('\n=== Chunk processing ===');
            console.log('LLM returned:');
            console.log(`- Original positions: ${chunk.startIndex}-${chunk.endIndex}`);
            console.log(`- Adjusted start: ${startIndex}, end: ${endIndex}`);
            console.log(`- First word: "${chunk.firstWord}"`);
            console.log(`- Last word: "${chunk.lastWord}"`);
            
            // Find where the LLM's suggested words actually appear in the text
            // For the start position, we can use the previous chunk's end as fallback
            const previousChunkEnd = index > 0 ? result.chunks[index - 1].endIndex : 0;
            const adjustedStartIndex = findWordPosition(fullText, chunk.firstWord, startIndex, true, previousChunkEnd);
            
            // For the end position, we'll allow overlap beyond the LLM's suggestion
            const adjustedEndIndex = findWordPosition(fullText, chunk.lastWord, endIndex, false);
            
            // When calculating offsets, we need to ignore the arbitrary overlap we added
            // This ensures the next chunk's position calculations aren't thrown off
            const effectiveEndIndex = Math.min(adjustedEndIndex, adjustedEndIndex + tolerance);
            
            console.log(`Position adjustments:`);
            console.log(`- Original start: ${chunk.startIndex}, end: ${chunk.endIndex}`);
            console.log(`- Adjusted start: ${adjustedStartIndex + 1}, end: ${adjustedEndIndex}`);
            console.log(`- Effective end (without overlap): ${effectiveEndIndex}`);

            // Extract the text between our found positions (including overlap)
            const chunkText = fullText.substring(adjustedStartIndex, adjustedEndIndex);
            
            // Find where the period actually is for validation
            const periodIndex = fullText.indexOf('.', adjustedStartIndex);
            console.log('\nPosition analysis:');
            console.log(`- LLM wants to end at: ${chunk.endIndex}`);
            console.log(`- Next period is at: ${periodIndex}`);
            console.log(`- Text up to period:\n${fullText.substring(adjustedStartIndex, periodIndex + 1)}`);
            console.log(`- Text after period:\n${fullText.substring(periodIndex + 1, chunk.endIndex)}`);
            
            // Check if our position adjustments stayed within tolerance
            const positionDifference = Math.abs(adjustedEndIndex - effectiveEndIndex);
            const withinTolerance = positionDifference <= tolerance;
            
            // Get the actual words we found at our chosen positions for validation
            const actualFirstWord = fullText.substring(adjustedStartIndex).split(/\s+/)[0];
            const actualLastWord = fullText.substring(0, effectiveEndIndex).split(/\s+/).pop();
            
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
            
            const firstWordMatch = fuzzyMatch(actualFirstWord, chunk.firstWord);
            const lastWordMatch = fuzzyMatch(actualLastWord, chunk.lastWord);
            
            console.log('\nWord matching:');
            console.log(`- First word match: ${firstWordMatch ? 'YES' : 'NO'}`);
            console.log(`  LLM: "${chunk.firstWord}"`);
            console.log(`  Our: "${actualFirstWord}"`);
            console.log(`- Last word match: ${lastWordMatch ? 'YES' : 'NO'}`);
            console.log(`  LLM: "${chunk.lastWord}"`);
            console.log(`  Our: "${actualLastWord}"`);
            console.log(`- Within tolerance: ${withinTolerance ? 'YES' : 'NO'}`);
            console.log(`  LLM wanted: ${adjustedEndIndex}`);
            console.log(`  We found: ${effectiveEndIndex}`);
            console.log(`  Difference: ${positionDifference} chars`);
            
            return {
                startIndex: adjustedStartIndex + 1, // Keep 1-indexed for consistency with LLM
                endIndex: adjustedEndIndex,
                firstWord: fullText.substring(adjustedStartIndex, adjustedStartIndex + chunk.firstWord.length),
                lastWord: fullText.substring(adjustedEndIndex - chunk.lastWord.length, adjustedEndIndex),
                cleanedText: chunkText,
                first_word_match: firstWordMatch,
                last_word_match: lastWordMatch,
                within_tolerance: withinTolerance,
                position_difference: positionDifference,
                llm_suggested_end: adjustedEndIndex,
                actual_end: adjustedEndIndex
            };
        });

        // Generate metadata for chunks
        console.log('\n=== Chunk Metadata Generation ===');
        for (let i = 0; i < result.chunks.length; i++) {
            const chunk = result.chunks[i];
            const isLastChunk = i === result.chunks.length - 1;
            
            // Skip metadata for last chunk if this is a continuation and there's no remainder
            if (isLastChunk && isContinuation) {
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

            console.log(`\nGenerating metadata for chunk ${i + 1}/${result.chunks.length}...`);
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
                } else {
                    console.log('Chunk metadata saved successfully');
                }
            } catch (metadataError) {
                console.error(`Error generating metadata for chunk ${i + 1}:`, metadataError);
            }
        }
    }

    // Validate chunks
    console.log('\n=== Chunk Validation ===');
    const warnings = validateChunks(result.chunks, fullText);
    if (warnings.length > 0) {
        console.log('Validation warnings:', warnings);
    } else {
        console.log('No validation warnings');
    }

    // Store chunks in database
    console.log('\n=== Database Storage ===');
    console.log('Storing results in database...');
    await saveAnalysis(content, 'chunk', { 
        ...result, 
        filepath,
        document_source_id: document.document_source_id,
        document: document
    });
    console.log('Results stored successfully');
    
    // Store remainder for next document if needed
    if (result.chunks && result.chunks.length > 0) {
        const lastChunk = result.chunks[result.chunks.length - 1];
        const remainder = fullText.substring(lastChunk.endIndex);
        if (remainder.trim()) {
            console.log('\n=== Remainder Storage ===');
            console.log('Remainder length:', remainder.length);
            console.log('Remainder preview:', remainder.substring(0, 100) + '...');
            
            const { error: remainderError } = await supabase
                .from('document_remainders')
                .insert({
                    document_id: document.id,
                    remainder_text: remainder,
                    created_at: new Date().toISOString()
                });
                
            if (remainderError) {
                console.error('Error saving remainder:', remainderError);
            } else {
                console.log('Remainder saved successfully');
            }
        }
    }
    
    console.log('\n=== Processing Complete ===\n');
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