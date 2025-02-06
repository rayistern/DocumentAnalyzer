import OpenAI from 'openai';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type, maxChunkLength = 2000) {
    try {
        console.log('\nChunking Parameters:');
        console.log('Text length:', content.length);
        console.log('Max chunk length:', maxChunkLength);

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
            model: "o1-preview",
            messages: [
                {
                    role: "user",
                    content: `Analyze the following text and identify natural chunk boundaries following these rules:
                    1. Decide each chunk according to natural thought or thematic boundaries
                    2. Chunks MUST NOT cut words in half
                    3. Keep chunks under ${maxChunkLength} characters
                    4. Record the first and last complete words of each chunk, including any surrounding whitespace
                    5. The first chunk MUST start at index 1
                    6. Each subsequent chunk MUST start at one character beyond the index where the previous chunk ended
                    7. There MUST NOT be any overlaps between chunks
                    8. Include punctuation
                    9. Each chunk should end with a complete sentence

                    Return a valid JSON in the following exact format. Do not include any preface that this is a json:
                    {
                        "chunks": [
                            {
                                "startIndex": 1,
                                "endIndex": 12,
                                "firstWord": "The",
                                "lastWord": "sat."
                            }
                        ]
                    }`
                },
                {
                    role: "user",
                    content: text
                }
            ]
        });

        console.log('\nAI Response:');
        console.log(response.choices[0].message.content);

        const result = JSON.parse(response.choices[0].message.content);
        const chunks = result.chunks || [];

        console.log('\nChunk Overview:');
        console.log('Number of chunks:', chunks.length);

        // Validate each chunk and collect warnings
        const warnings = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkText = text.slice(chunk.startIndex - 1, chunk.endIndex);
            const nextContext = text.slice(chunk.endIndex, chunk.endIndex + 50);

            console.log(`\nValidating Chunk ${i + 1}/${chunks.length}:`);
            console.log('Full chunk text:', chunkText);
            console.log('Next 50 chars:', nextContext);

            const prevChar = chunk.startIndex > 1 ? text[chunk.startIndex - 2] : "";
            const nextChar = chunk.endIndex < text.length ? text[chunk.endIndex] : "";
            console.log('Boundary characters:', {
                before: prevChar,
                after: nextChar
            });

            // Split into words while preserving whitespace, filter out empty strings
            const words = chunkText.split(/(\s+)/).filter(word => word.length > 0);
            const actualFirstWord = words.find(w => /\S/.test(w)) || '';
            const actualLastWord = [...words].reverse().find(w => /\S/.test(w)) || '';

            console.log('Word boundaries:', {
                expected: { first: chunk.firstWord, last: chunk.lastWord },
                actual: { first: actualFirstWord, last: actualLastWord }
            });

            // Collect warnings instead of throwing errors
            if (!/[.!?]\s*$/.test(chunkText)) {
                warnings.push(`Warning: Chunk ${i} does not end with a complete sentence`);
            }

            if (chunkText.length > maxChunkLength) {
                warnings.push(`Warning: Chunk ${i} exceeds maximum length`);
            }

            if (actualFirstWord !== chunk.firstWord || actualLastWord !== chunk.lastWord) {
                warnings.push(`Warning: Chunk ${i} boundary mismatch - expected "${chunk.firstWord}"..."${chunk.lastWord}", got "${actualFirstWord}"..."${actualLastWord}"`);
            }

            if (i > 0) {
                const prevChunk = chunks[i - 1];
                if (chunk.startIndex !== prevChunk.endIndex + 1) {
                    warnings.push(`Warning: Chunk ${i} does not start where previous chunk ended`);
                }
            } else if (chunk.startIndex !== 1) {
                warnings.push('Warning: First chunk does not start at index 1');
            }

            if (i < chunks.length - 1) {
                const nextChunkStart = text.slice(chunk.endIndex);
                const nextExpectedWord = chunks[i + 1].firstWord;
                if (!nextChunkStart.startsWith(nextExpectedWord)) {
                    warnings.push(`Warning: Next chunk should start with "${nextExpectedWord}" but found "${nextChunkStart.slice(0, nextExpectedWord.length)}"`);
                }
            }
        }

        // Log all warnings
        if (warnings.length > 0) {
            console.log('\nValidation Warnings:');
            warnings.forEach(warning => console.log(warning));
        }

        return {
            totalLength: text.length,
            chunks: chunks,
            warnings: warnings
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