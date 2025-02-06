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
        const rawResponse = responsePayload?.choices?.[0]?.message?.content || null;
        let parsedResponse = null;
        try {
            parsedResponse = rawResponse ? JSON.parse(rawResponse) : null;
        } catch (e) {
            console.error('Failed to parse response:', e);
        }

        await db.insert(apiLogs).values({
            requestType,
            requestPayload,
            responsePayload: {
                raw: rawResponse,
                parsed: parsedResponse,
                fullResponse: responsePayload
            },
            success,
            error: error?.message || null
        });
    } catch (e) {
        console.error('Failed to log API call:', e);
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

async function logChunkValidation(documentId, chunkIndex, expected, actual, chunkText, passed, error = null, fullText = '', startIndex = 0, endIndex = 0) {
    try {
        const afterContext = fullText.substring(endIndex, Math.min(fullText.length, endIndex + 100));
        const beforeContext = fullText.substring(Math.max(0, startIndex - 100), startIndex);

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
            followingContext: afterContext,
            validationPassed: passed,
            validationError: error?.message || null
        });

        await logAppEvent('debug', 'Chunk validation details', {
            chunkIndex,
            beforeContext,
            chunk: chunkText,
            afterContext,
            expected,
            actual,
            error: error?.message,
            textAround: {
                before: beforeContext,
                after: afterContext
            }
        });
    } catch (e) {
        console.error('Failed to log chunk validation:', e);
    }
}

export async function processFile(text, type, maxChunkLength = 2000) {
    try {
        if (type === 'sentiment') {
            return await analyzeSentiment(text);
        } else if (type === 'chunk') {
            return await chunkContent(text, parseInt(maxChunkLength));
        } else {
            return await summarizeContent(text);
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
                content: `Break the following text into chunks, following these STRICT rules:

1. Each chunk MUST end with a complete sentence followed by whitespace or end of text
   - Valid sentence endings are: period, exclamation mark, or question mark
   - The ending punctuation must be followed by a space, newline, or end of text

2. Word boundary rules:
   - NEVER split in the middle of a word
   - Each chunk must start and end with complete words
   - Before starting a chunk, ensure there's whitespace or start of text
   - After ending a chunk, ensure there's whitespace or end of text

3. Additional requirements:
   - Maximum chunk length: ${maxChunkLength} characters
   - Use zero-based indexing for all positions
   - Include ending punctuation in the last word

Example 1:
Text: "This is a test. Second sentence here."
Valid chunk: { startIndex: 0, endIndex: 15, firstWord: "This", lastWord: "test." }

Example 2:
Text: "Hello world! Next part."
Valid chunk: { startIndex: 0, endIndex: 12, firstWord: "Hello", lastWord: "world!" }
Invalid: { startIndex: 0, endIndex: 5, firstWord: "Hello", lastWord: "wo" } // Splits "world"

Return JSON:
{
    "chunks": [
        {
            "startIndex": <number>,     // Position where chunk starts (0-based)
            "endIndex": <number>,       // Position where chunk ends (0-based)
            "firstWord": "exact word",  // First complete word in chunk
            "lastWord": "exact word"    // Last complete word with punctuation
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

        await logAppEvent('info', 'Received chunk response', { 
            response: response.choices[0].message.content,
            parsed: result
        });

        const chunks = result.chunks || [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            // Validate and convert indexes
            chunk.startIndex = Number(chunk.startIndex);
            chunk.endIndex = Number(chunk.endIndex);

            if (isNaN(chunk.startIndex) || isNaN(chunk.endIndex)) {
                throw new Error(`Invalid indexes in chunk ${i}: start=${chunk.startIndex}, end=${chunk.endIndex}`);
            }

            // Extract the chunk text and analyze boundaries
            const chunkText = text.slice(chunk.startIndex, chunk.endIndex);
            const prevChar = chunk.startIndex > 0 ? text[chunk.startIndex - 1] : '';
            const nextChar = chunk.endIndex < text.length ? text[chunk.endIndex] : '';

            // Check word boundaries
            const hasValidStart = chunk.startIndex === 0 || /\s/.test(prevChar);
            const hasValidEnd = chunk.endIndex === text.length || /\s/.test(nextChar);
            const endsWithSentence = /[.!?][\s\n]*$/.test(chunkText);

            // Get actual first and last words
            const words = chunkText.trim().split(/\s+/);
            const actualFirstWord = words[0];
            const actualLastWord = words[words.length - 1];

            const expected = { first: chunk.firstWord, last: chunk.lastWord };
            const actual = { first: actualFirstWord, last: actualLastWord };

            // Detailed validation logging
            await logAppEvent('debug', `Chunk ${i} validation`, {
                indexes: { start: chunk.startIndex, end: chunk.endIndex },
                text: chunkText,
                boundaries: {
                    prevChar,
                    nextChar,
                    hasValidStart,
                    hasValidEnd,
                    endsWithSentence
                },
                words: {
                    expected,
                    actual,
                    allWords: words
                }
            });

            // Comprehensive validation
            const validationPassed = actualFirstWord === chunk.firstWord &&
                                   actualLastWord === chunk.lastWord &&
                                   chunkText.length <= maxChunkLength &&
                                   hasValidStart &&
                                   hasValidEnd &&
                                   endsWithSentence;

            let validationError = null;
            if (!validationPassed) {
                if (!hasValidStart || !hasValidEnd) {
                    validationError = new Error(`Chunk boundaries split a word: prevChar="${prevChar}", nextChar="${nextChar}"`);
                } else if (actualFirstWord !== chunk.firstWord) {
                    validationError = new Error(`First word mismatch at index ${chunk.startIndex}: AI claimed "${chunk.firstWord}" but found "${actualFirstWord}"`);
                } else if (actualLastWord !== chunk.lastWord) {
                    validationError = new Error(`Last word mismatch at index ${chunk.endIndex}: AI claimed "${chunk.lastWord}" but found "${actualLastWord}"`);
                } else if (chunkText.length > maxChunkLength) {
                    validationError = new Error(`Chunk exceeds maximum length of ${maxChunkLength} characters (actual: ${chunkText.length})`);
                } else if (!endsWithSentence) {
                    validationError = new Error(`Chunk does not end with a complete sentence`);
                }
            }

            await logChunkValidation(
                null,
                i,
                expected,
                actual,
                chunkText,
                validationPassed,
                validationError,
                text,
                chunk.startIndex,
                chunk.endIndex
            );

            if (!validationPassed) {
                await logApiCall('chunk', requestPayload, response, false, validationError);
                throw validationError;
            }
        }

        return {
            totalLength: text.length,
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