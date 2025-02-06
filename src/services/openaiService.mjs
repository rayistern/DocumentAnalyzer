import OpenAI from 'openai';

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
        const response = await openai.chat.completions.create({
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
        });

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

            // Log chunk details for debugging
            console.log(`Validating chunk ${i}:`, {
                text: chunkText,
                expected: { first: chunk.firstWord, last: chunk.lastWord },
                actual: { first: actualFirstWord, last: actualLastWord }
            });

            if (actualFirstWord !== chunk.firstWord || actualLastWord !== chunk.lastWord) {
                throw new Error(`Chunk ${i} boundary validation failed`);
            }

            if (chunkText.length > maxChunkLength) {
                throw new Error(`Chunk ${i} exceeds maximum length`);
            }

            // Ensure the chunk ends with a complete sentence
            if (!/[.!?][\s]*$/.test(chunkText.trim())) {
                throw new Error(`Chunk ${i} does not end with a complete sentence`);
            }
        }

        return {
            totalLength: text.length,
            chunkCount: chunks.length,
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