import OpenAI from 'openai';
import { logChunkValidation, logOpenAIResponse } from './loggingService.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

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
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

async function chunkContent(text, maxChunkLength = 2000) {
    try {
        const systemPrompt = `Split the following text into chunks and return a JSON object following these rules:
1. Each chunk MUST end with a complete sentence (ending with ".", "!", or "?")
2. The endIndex should point to the sentence-ending character (., !, or ?), not the space after
3. NEVER split mid-sentence or mid-word
4. Keep chunks under ${maxChunkLength} characters
5. Record the exact first and last words of each chunk for validation`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: text
                }
            ],
            response_format: { type: "json_object" }
        });

        // Log the OpenAI interaction
        await logOpenAIResponse(systemPrompt, response);

        const result = JSON.parse(response.choices[0].message.content);

        // Validate chunks
        const chunks = result.chunks || [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkText = text.slice(chunk.startIndex, chunk.endIndex + 1); // +1 to include the period

            // Get context around chunk boundaries
            const contextBefore = text.slice(Math.max(0, chunk.startIndex - 20), chunk.startIndex);
            const contextAfter = text.slice(chunk.endIndex + 1, Math.min(text.length, chunk.endIndex + 21));

            // Clean and split the chunk text
            const words = chunkText.trim().split(/\s+/);
            const actualFirstWord = words[0];
            const actualLastWord = words[words.length - 1];

            // Prepare validation details for logging
            const validationDetails = {
                text: chunkText,
                context: {
                    before: `...${contextBefore}`,
                    after: `${contextAfter}...`
                },
                expected: { first: chunk.firstWord, last: chunk.lastWord },
                actual: { first: actualFirstWord, last: actualLastWord },
                length: chunkText.length,
                endsWithSentence: /[.!?]$/.test(chunkText.trim())
            };

            // Log validation details
            await logChunkValidation(i, validationDetails);

            // Perform validation
            if (actualFirstWord !== chunk.firstWord || actualLastWord !== chunk.lastWord) {
                throw new Error(`Chunk ${i} boundary validation failed`);
            }

            if (chunkText.length > maxChunkLength) {
                throw new Error(`Chunk ${i} exceeds maximum length of ${maxChunkLength} characters`);
            }

            if (!/[.!?]$/.test(chunkText.trim())) {
                throw new Error(`Chunk ${i} does not end with a complete sentence`);
            }
        }

        return {
            totalLength: text.length,
            chunks: chunks
        };
    } catch (error) {
        throw new Error(`Chunking failed: ${error.message}`);
    }
}

async function summarizeContent(text) {
    try {
        const response = await openai.chat.completions.create({
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
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    try {
        const response = await openai.chat.completions.create({
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
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}