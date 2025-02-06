import OpenAI from 'openai';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { apiLogs, chunkValidationLogs, appLogs } from '../schema.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const db = drizzle(pool);

async function logApiCall(requestType, requestPayload, responsePayload, success, error = null) {
    try {
        await db.insert(apiLogs).values({
            requestType,
            requestPayload,
            responsePayload,
            success,
            error: error?.message
        });
    } catch (e) {
        console.error('Failed to log API call:', e);
    }
}

async function logChunkValidation(documentId, chunkIndex, expected, actual, chunkText, passed, error = null, fullText = '', startIndex = 0, endIndex = 0) {
    try {
        const followingContext = fullText.substring(endIndex, endIndex + 5);
        await db.insert(chunkValidationLogs).values({
            documentId,
            chunkIndex,
            startIndex,
            endIndex,
            expectedFirstWord: expected.first,
            expectedLastWord: expected.last,
            actualFirstWord: actual.first,
            actualLastWord: actual.last,
            chunkText,
            followingContext,
            validationPassed: passed,
            validationError: error?.message
        });
    } catch (e) {
        console.error('Failed to log chunk validation:', e);
    }
}

async function logAppEvent(level, message, metadata = null) {
    try {
        await db.insert(appLogs).values({
            level,
            message,
            metadata
        });
    } catch (e) {
        console.error('Failed to log app event:', e);
    }
}

export async function processFile(content, type, maxChunkLength = 2000) {
    try {
        if (type === 'sentiment') {
            return await analyzeSentiment(content);
        } else if (type === 'chunk') {
            return await chunkContent(content, parseInt(maxChunkLength));
        } else {
            return await summarizeContent(content);
        }
    } catch (error) {
        await logAppEvent('error', `File processing failed: ${error.message}`, { type, error: error.message });
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

async function chunkContent(text, maxChunkLength = 2000) {
    const requestPayload = {
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: `Analyze the following text and identify natural chunk boundaries following these rules:
                1. Each chunk MUST end at complete sentences or natural thought boundaries
                2. Chunks MUST NOT cut words in half
                3. Keep chunks under ${maxChunkLength} characters
                4. Record the exact first and last complete words of each chunk

                Return a JSON object with:
                {
                    "chunks": [
                        {
                            "startIndex": <number>,
                            "endIndex": <number>,
                            "firstWord": "exact first word",
                            "lastWord": "exact last word"
                        }
                    ]
                }`
            },
            {
                role: "user",
                content: text
            }
        ],
        response_format: { type: "json_object" }
    };

    try {
        const response = await openai.chat.completions.create(requestPayload);
        await logApiCall('chunk', requestPayload, response, true);

        const result = JSON.parse(response.choices[0].message.content);

        // Validate chunks
        const chunks = result.chunks || [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkText = text.slice(chunk.startIndex, chunk.endIndex);

            // Clean and split the chunk text
            const words = chunkText.trim().split(/\s+/);
            const actualFirstWord = words[0];
            const actualLastWord = words[words.length - 1];

            const expected = { first: chunk.firstWord, last: chunk.lastWord };
            const actual = { first: actualFirstWord, last: actualLastWord };

            const validationPassed = actualFirstWord === chunk.firstWord && 
                                   actualLastWord === chunk.lastWord &&
                                   chunkText.length <= maxChunkLength &&
                                   /[.!?][\s]*$/.test(chunkText.trim());

            let validationError = null;
            if (!validationPassed) {
                if (actualFirstWord !== chunk.firstWord) {
                    validationError = `First word mismatch at index ${chunk.startIndex}: AI claimed "${chunk.firstWord}" but actual text starts with "${actualFirstWord}"`;
                } else if (actualLastWord !== chunk.lastWord) {
                    validationError = `Last word mismatch at index ${chunk.endIndex}: AI claimed "${chunk.lastWord}" but actual text ends with "${actualLastWord}"`;
                } else if (chunkText.length > maxChunkLength) {
                    validationError = `Chunk at index ${chunk.startIndex}-${chunk.endIndex} exceeds maximum length of ${maxChunkLength} characters (actual: ${chunkText.length})`;
                } else if (!/[.!?][\s]*$/.test(chunkText.trim())) {
                    validationError = `Chunk at index ${chunk.startIndex}-${chunk.endIndex} does not end with a complete sentence`;
                }
            }

            await logChunkValidation(
                null, // documentId will be set later
                i,
                expected,
                actual,
                chunkText,
                validationPassed,
                validationError ? new Error(validationError) : null,
                text,
                chunk.startIndex,
                chunk.endIndex
            );

            if (!validationPassed) {
                const error = new Error(validationError);
                await logApiCall('chunk', requestPayload, result, false, error);
                throw error;
            }
        }

        return {
            totalLength: text.length,
            chunkCount: chunks.length,
            chunks: chunks
        };
    } catch (error) {
        await logAppEvent('error', `Chunking failed: ${error.message}`, { error: error.message });
        throw new Error(`Chunking failed: ${error.message}`);
    }
}

async function summarizeContent(text) {
    const requestPayload = {
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: "Summarize the following text and provide the result in JSON format with 'summary' and 'keyPoints' fields."
            },
            {
                role: "user",
                content: text
            }
        ],
        response_format: { type: "json_object" }
    };

    try {
        const response = await openai.chat.completions.create(requestPayload);
        await logApiCall('summary', requestPayload, response, true);
        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        await logApiCall('summary', requestPayload, null, false, error);
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    const requestPayload = {
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: "Analyze the sentiment of the text and provide a JSON response with 'sentiment' (positive/negative/neutral), 'score' (1-5), and 'confidence' (0-1) fields."
            },
            {
                role: "user",
                content: text
            }
        ],
        response_format: { type: "json_object" }
    };

    try {
        const response = await openai.chat.completions.create(requestPayload);
        await logApiCall('sentiment', requestPayload, response, true);
        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        await logApiCall('sentiment', requestPayload, null, false, error);
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}