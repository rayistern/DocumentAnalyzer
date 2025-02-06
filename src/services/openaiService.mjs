import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';

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

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
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

        const result = JSON.parse(response.choices[0].message.content);
        result.warnings = validateChunks(result.chunks, text);
        return result;
    } catch (error) {
        throw new Error(`Chunk creation failed: ${error.message}`);
    }
}

function validateChunks(chunks, originalText) {
    const warnings = [];
    let previousEndIndex = 0;

    chunks.forEach((chunk, index) => {
        // Check for gaps between chunks
        if (chunk.startIndex !== previousEndIndex + 1 && index > 0) {
            const gapText = originalText.slice(previousEndIndex, chunk.startIndex - 1);
            warnings.push(`Gap detected between chunk ${index} and ${index + 1}. Gap content: "${gapText}"`);
        }

        // Check for sentence boundaries
        const chunkText = originalText.slice(chunk.startIndex - 1, chunk.endIndex);
        const endsWithPeriod = chunkText.trim().match(/[.!?]$/);

        if (!endsWithPeriod) {
            warnings.push(`Chunk ${index + 1} does not end with a sentence break: "${chunkText}"`);
        }

        // Verify chunk size
        const chunkLength = chunk.endIndex - chunk.startIndex + 1;
        if (chunkLength > OPENAI_SETTINGS.defaultMaxChunkLength) {
            warnings.push(`Chunk ${index + 1} exceeds maximum length (${chunkLength} > ${OPENAI_SETTINGS.defaultMaxChunkLength})`);
        }

        previousEndIndex = chunk.endIndex;
    });

    // Check if we processed the entire text
    if (previousEndIndex < originalText.length) {
        const remainingText = originalText.slice(previousEndIndex);
        warnings.push(`Unprocessed text remaining: "${remainingText}"`);
    }

    return warnings;
}