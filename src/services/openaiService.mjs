import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';
import { logLLMResponse } from './llmLoggingService.mjs';
import { saveAnalysis } from './supabaseService.mjs';
import dotenv from 'dotenv'

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
            const actualText = originalText.substring(item.startPosition - 1, item.endPosition);

            if (actualText === item.text || 
                (Math.abs(actualText.length - item.text.length) <= tolerance && 
                 actualText.includes(item.text))) {
                cleanedText = cleanedText.replace(new RegExp(escapeRegExp(item.text), 'g'), '');
            } else {
                console.warn(`Warning: Text "${item.text}" not found at specified position (${item.startPosition}-${item.endPosition}). Found "${actualText}" instead.`);
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

function validateChunks(chunks, originalText) {
    const documentWarnings = [];
    
    chunks.forEach((chunk, index) => {
        const chunkWarnings = [];
        
        if (chunk.startIndex !== (index === 0 ? 1 : chunks[index - 1].endIndex + 1)) {
            const gapText = originalText.slice(index === 0 ? 0 : chunks[index - 1].endIndex, chunk.startIndex - 1);
            chunkWarnings.push(`Gap detected before this chunk. Gap content: "${gapText}"`);
        }

        const chunkText = originalText.slice(chunk.startIndex - 1, chunk.endIndex);
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

    if (chunks[chunks.length - 1].endIndex < originalText.length) {
        const remainingText = originalText.slice(chunks[chunks.length - 1].endIndex);
        documentWarnings.push(`Unprocessed text remaining: "${remainingText}"`);
    }

    return documentWarnings;
}