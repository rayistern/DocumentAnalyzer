import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';
import { logLLMResponse } from './llmLoggingService.mjs';
import { saveAnalysis, saveCleanedDocument } from './supabaseService.mjs';
import dotenv from 'dotenv'
import { supabase } from './supabaseService.mjs';

dotenv.config()

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type, filepath, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength) {
    try {
        switch (type) {
            case 'sentiment':
                return await analyzeSentiment(content);
            case 'chunk':
                return await createChunks(content, maxChunkLength, filepath);
            case 'cleanAndChunk':
                return await cleanAndChunkDocument(content, maxChunkLength, filepath);
            default:
                return await summarizeContent(content);
        }
    } catch (error) {
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

function cleanText(text, textToRemove, originalText) {
    let cleanedText = text;
    const tolerance = OPENAI_SETTINGS.textRemovalPositionTolerance;

    if (textToRemove && Array.isArray(textToRemove)) {
        textToRemove.forEach(item => {
            // Try to find by position first
            const actualText = originalText.substring(item.startPosition - 1, item.endPosition);
            let found = false;

            // Check if position-based match works
            if (actualText === item.text || 
                (Math.abs(actualText.length - item.text.length) <= tolerance && 
                 actualText.includes(item.text))) {
                found = true;
                cleanedText = cleanedText.replace(new RegExp(escapeRegExp(actualText), 'g'), '');
                console.log(`Removed text by position match: "${actualText}"`);
            }

            // If not found by position, try context matching
            if (!found && item.contextBefore && item.contextAfter) {
                const pattern = escapeRegExp(item.contextBefore + item.text + item.contextAfter);
                if (text.match(pattern)) {
                    found = true;
                    cleanedText = cleanedText.replace(new RegExp(pattern, 'g'), '');
                    console.log(`Removed text by context match: "${item.text}" with context`);
                } else {
                    // Try just the text with either context
                    const beforePattern = escapeRegExp(item.contextBefore + item.text);
                    const afterPattern = escapeRegExp(item.text + item.contextAfter);
                    if (text.match(beforePattern)) {
                        found = true;
                        cleanedText = cleanedText.replace(new RegExp(beforePattern, 'g'), '');
                        console.log(`Removed text by before-context match: "${item.text}"`);
                    } else if (text.match(afterPattern)) {
                        found = true;
                        cleanedText = cleanedText.replace(new RegExp(afterPattern, 'g'), '');
                        console.log(`Removed text by after-context match: "${item.text}"`);
                    }
                }
            }

            if (!found) {
                // If still not found, try just the text itself as a last resort
                if (text.includes(item.text)) {
                    cleanedText = cleanedText.replace(new RegExp(escapeRegExp(item.text), 'g'), '');
                    console.log(`Removed text by exact match: "${item.text}"`);
                } else {
                    console.warn(`Warning: Could not find text "${item.text}" at position ${item.startPosition}-${item.endPosition} or with context`);
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
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                {
                    role: OPENAI_PROMPTS.chunk.role,
                    content: OPENAI_PROMPTS.chunk.content(maxChunkLength)
                },
                {
                    role: "user",
                    content: text
                }
            ],
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);

        const cleanResponse = removeMarkdownFormatting(response.choices[0].message.content);
        const result = JSON.parse(cleanResponse);

        if (result.chunks && result.textToRemove) {
            result.chunks = result.chunks.map(chunk => {
                const originalText = text.slice(chunk.startIndex - 1, chunk.endIndex);
                const cleanedText = cleanText(originalText, result.textToRemove, text);
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
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                OPENAI_PROMPTS.summarize,
                {
                    role: "user",
                    content: text
                }
            ],
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);
        const result = JSON.parse(response.choices[0].message.content);
        
        // Store in Supabase
        await saveAnalysis(text, 'summary', result);
        
        return result;
    } catch (error) {
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                OPENAI_PROMPTS.sentiment,
                {
                    role: "user",
                    content: text
                }
            ],
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);
        const result = JSON.parse(response.choices[0].message.content);
        
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
            chunkWarnings.push(`Gap detected before this chunk. Gap content: "${gapText}"`);
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

async function cleanAndChunkDocument(text, maxChunkLength, filepath) {
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

        // Step 1: Clean the text
        const cleanResponse = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                OPENAI_PROMPTS.cleanAndChunk.clean(),
                {
                    role: "user",
                    content: text
                }
            ],
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        console.log('Clean response received:', cleanResponse.choices[0].message.content);
        await logLLMResponse(null, cleanResponse.choices[0].message.content, OPENAI_SETTINGS.model);
        const cleanResult = JSON.parse(removeMarkdownFormatting(cleanResponse.choices[0].message.content));
        console.log('Parsed clean result:', cleanResult);
        
        // Clean the text using the removal instructions
        const cleanedText = cleanText(text, cleanResult.textToRemove, text);
        console.log('Cleaned text:', cleanedText);
        
        // Save cleaned text to database using the document ID we got earlier
        console.log('Saving cleaned version to database...');
        await saveCleanedDocument(document.id, cleanedText, text, OPENAI_SETTINGS.model);

        // Step 2: Chunk the cleaned text
        console.log('Starting chunking process on cleaned text...');
        const chunkResponse = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                OPENAI_PROMPTS.cleanAndChunk.chunk(maxChunkLength),
                {
                    role: "user",
                    content: cleanedText
                }
            ],
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        console.log('Chunk response received:', chunkResponse.choices[0].message.content);
        await logLLMResponse(null, chunkResponse.choices[0].message.content, OPENAI_SETTINGS.model);
        const chunkResult = JSON.parse(removeMarkdownFormatting(chunkResponse.choices[0].message.content));
        console.log('Parsed chunk result:', chunkResult);

        // Add actual text to chunks from the cleaned text
        if (chunkResult.chunks) {
            chunkResult.chunks = chunkResult.chunks.map(chunk => ({
                ...chunk,
                cleanedText: cleanedText.slice(chunk.startIndex - 1, chunk.endIndex)
            }));
        }

        const warnings = validateChunks(chunkResult.chunks, cleanedText);
        console.log('Validation warnings:', warnings);

        const result = {
            textToRemove: cleanResult.textToRemove,
            chunks: chunkResult.chunks,
            warnings
        };

        // Store chunks in database
        await saveAnalysis(cleanedText, 'chunk', { 
            ...result, 
            filepath,
            document_source_id: document.document_source_id,
            document: document 
        });
        
        // Step 3: Generate metadata for each chunk
        if (chunkResult.chunks) {
            console.log('Generating metadata for chunks...');
            for (let i = 0; i < chunkResult.chunks.length; i++) {
                const chunk = chunkResult.chunks[i];
                console.log(`Generating metadata for chunk ${i + 1}/${chunkResult.chunks.length}...`);
                try {
                    const response = await openai.chat.completions.create({
                        model: OPENAI_SETTINGS.model,
                        messages: [
                            OPENAI_PROMPTS.metadata(),
                            {
                                role: "user",
                                content: chunk.cleanedText
                            }
                        ],
                        ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                            response_format: { type: "json_object" }
                        })
                    });

                    await logLLMResponse(null, response.choices[0].message.content, OPENAI_SETTINGS.model);
                    
                    // Parse the metadata JSON
                    console.log('Raw metadata response:', response.choices[0].message.content);
                    const metadata = JSON.parse(removeMarkdownFormatting(response.choices[0].message.content));
                    console.log('Parsed metadata:', metadata);
                    
                    // Store raw response in chunk for backup
                    chunk.metadata = response.choices[0].message.content;
                    
                    // Prepare metadata object for insertion with all fields
                    const metadataObject = { 
                        document_id: document.id,
                        chunk_index: chunk.startIndex,
                        long_summary: metadata.long_summary,
                        short_summary: metadata.short_summary,
                        quiz_questions: Array.isArray(metadata.quiz_questions) ? metadata.quiz_questions : null,
                        followup_thinking_questions: Array.isArray(metadata.followup_thinking_questions) ? metadata.followup_thinking_questions : null,
                        generated_title: metadata.generated_title,
                        tags_he: Array.isArray(metadata.tags_he) ? metadata.tags_he : null,
                        key_terms_he: Array.isArray(metadata.key_terms_he) ? metadata.key_terms_he : null,
                        key_phrases_he: Array.isArray(metadata.key_phrases_he) ? metadata.key_phrases_he : null,
                        key_phrases_en: Array.isArray(metadata.key_phrases_en) ? metadata.key_phrases_en : null,
                        bibliography_snippets: Array.isArray(metadata.bibliography_snippets) ? metadata.bibliography_snippets : null,
                        questions_explicit: Array.isArray(metadata.questions_explicit) ? metadata.questions_explicit : null,
                        questions_implied: Array.isArray(metadata.questions_implied) ? metadata.questions_implied : null,
                        reconciled_issues: metadata.reconciled_issues ? [metadata.reconciled_issues] : null,
                        qa_pair: metadata.qa_pair ? JSON.stringify(metadata.qa_pair) : null,
                        potential_typos: Array.isArray(metadata.potential_typos) ? metadata.potential_typos : null,
                        identified_abbreviations: Array.isArray(metadata.identified_abbreviations) ? metadata.identified_abbreviations : null,
                        named_entities: Array.isArray(metadata.named_entities) ? metadata.named_entities : null
                    };
                    console.log('Attempting to save metadata object:', metadataObject);

                    // Save parsed metadata to chunk_metadata table
                    const { data: metadataData, error: metadataError } = await supabase
                        .from('chunk_metadata')
                        .upsert(metadataObject, { 
                            onConflict: 'document_id,chunk_index',
                            ignoreDuplicates: false 
                        });

                    if (metadataError) {
                        console.error(`Error saving metadata for chunk ${i + 1}:`, metadataError);
                        console.error('Failed metadata object:', metadataObject);
                        console.error('Error details:', metadataError.details);
                        console.error('Error message:', metadataError.message);
                        console.error('Error code:', metadataError.code);
                    } else {
                        console.log(`Successfully saved metadata for chunk ${i + 1}`);
                        console.log('Saved metadata data:', metadataData);
                    }

                    // Update the chunk with raw metadata as backup
                    const { error: updateError } = await supabase
                        .from('chunks')
                        .update({ 
                            raw_metadata: response.choices[0].message.content
                        })
                        .eq('document_id', document.id)
                        .eq('start_index', chunk.startIndex);

                    if (updateError) {
                        console.error(`Error updating metadata for chunk ${i + 1}:`, updateError);
                    } else {
                        console.log(`Successfully updated metadata for chunk ${i + 1}`);
                    }
                } catch (error) {
                    console.error(`Error generating metadata for chunk ${i + 1}:`, error);
                }
            }
        }
        
        return result;
    } catch (error) {
        console.error('Clean and chunk error:', error);
        throw new Error(`Clean and chunk operation failed: ${error.message}`);
    }
}