import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';
import { logLLMResponse } from './llmLoggingService.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength) {
    try {
        switch (type) {
            case 'sentiment':
                return await analyzeSentiment(content);
            case 'chunk':
                return await createChunks(content, maxChunkLength);
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

async function createChunks(text, maxChunkLength) {
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

        const result = JSON.parse(response.choices[0].message.content);

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

        return JSON.parse(response.choices[0].message.content);
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

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}

function validateChunks(chunks, originalText) {
    const warnings = [];
    let previousEndIndex = 0;

    chunks.forEach((chunk, index) => {
        if (chunk.startIndex !== previousEndIndex + 1 && index > 0) {
            const gapText = originalText.slice(previousEndIndex, chunk.startIndex - 1);
            warnings.push(`Gap detected between chunk ${index} and ${index + 1}. Gap content: "${gapText}"`);
        }

        const chunkText = originalText.slice(chunk.startIndex - 1, chunk.endIndex);
        const endsWithPeriod = chunkText.trim().match(/[.!?]$/);

        if (!endsWithPeriod) {
            warnings.push(`Chunk ${index + 1} does not end with a sentence break: "${chunkText}"`);
        }

        const chunkLength = chunk.endIndex - chunk.startIndex + 1;
        if (chunkLength > OPENAI_SETTINGS.defaultMaxChunkLength) {
            warnings.push(`Chunk ${index + 1} exceeds maximum length (${chunkLength} > ${OPENAI_SETTINGS.defaultMaxChunkLength})`);
        }

        previousEndIndex = chunk.endIndex;
    });

    if (previousEndIndex < originalText.length) {
        const remainingText = originalText.slice(previousEndIndex);
        warnings.push(`Unprocessed text remaining: "${remainingText}"`);
    }

    return warnings;
}