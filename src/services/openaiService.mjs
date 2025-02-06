import OpenAI from 'openai';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type, maxChunkLength = 2000) {
    try {
        // Log input parameters
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
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `Analyze the following text and identify natural chunk boundaries following these rules:
                    1. Each chunk MUST end at complete sentences or natural thought boundaries
                    2. Chunks MUST NOT cut words in half
                    3. Keep chunks under ${maxChunkLength} characters
                    4. Record the exact first and last complete words of each chunk
                    5. Each chunk MUST end after a complete word and punctuation mark
                    6. Each chunk MUST begin at the start of a complete word
                    7. Never end a chunk in the middle of a word or sentence
                    8. The first chunk MUST start at index 0
                    9. Each subsequent chunk MUST start at the index where the previous chunk ended
                    10. There MUST NOT be any overlaps between chunks
                    11. Each chunk boundary MUST have proper spacing (no partial words)
                    12. End each chunk at a period, exclamation mark, or question mark followed by whitespace
                    13. When choosing chunk boundaries, look for complete sentences
                    14. The first word of each chunk MUST be the start of a new sentence
                    15. Each chunk MUST end with proper punctuation (., !, or ?) and whitespace
                    16. NEVER split words between chunks - ensure complete words at both start and end
                    17. Every chunk boundary must occur at a space after sentence-ending punctuation

                    For example:
                    Given text: "The cat sat. The dog ran. Birds flew high in the sky. Trees swayed gently."

                    Return a JSON object in the following exact format:
                    {
                        "chunks": [
                            {
                                "startIndex": 0,
                                "endIndex": 13,
                                "firstWord": "The",
                                "lastWord": "sat."
                            },
                            {
                                "startIndex": 14,
                                "endIndex": 26,
                                "firstWord": "The",
                                "lastWord": "ran."
                            },
                            {
                                "startIndex": 27,
                                "endIndex": 51,
                                "firstWord": "Birds",
                                "lastWord": "sky."
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

        // Log complete AI response
        console.log('\nAI Response:');
        console.log(response.choices[0].message.content);

        const result = JSON.parse(response.choices[0].message.content);
        const chunks = result.chunks || [];

        // Log overview of chunks
        console.log('\nChunk Overview:');
        console.log('Number of chunks:', chunks.length);
        chunks.forEach((chunk, i) => {
            console.log(`\nChunk ${i + 1}/${chunks.length}:`);
            console.log('Indices:', { start: chunk.startIndex, end: chunk.endIndex });
            console.log('Length:', chunk.endIndex - chunk.startIndex);
            console.log('Expected words:', { first: chunk.firstWord, last: chunk.lastWord });
        });

        // Validate each chunk
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkText = text.slice(chunk.startIndex, chunk.endIndex);
            const nextContext = text.slice(chunk.endIndex, chunk.endIndex + 50);

            // Log detailed chunk information
            console.log(`\nValidating Chunk ${i + 1}/${chunks.length}:`);
            console.log('Full chunk text:', chunkText);
            console.log('Next 50 chars:', nextContext);

            // Check chunk boundaries
            const prevChar = chunk.startIndex > 0 ? text[chunk.startIndex - 1] : "";
            const nextChar = chunk.endIndex < text.length ? text[chunk.endIndex] : "";
            console.log('Boundary characters:', {
                before: prevChar,
                after: nextChar
            });

            // Clean and split the chunk text
            const words = chunkText.trim().split(/\s+/);
            const actualFirstWord = words[0];
            const actualLastWord = words[words.length - 1].replace(/[.!?]$/, '');

            console.log('Word boundaries:', {
                expected: { first: chunk.firstWord, last: chunk.lastWord },
                actual: { first: actualFirstWord, last: actualLastWord }
            });

            // 1. First check if the chunk ends with a complete sentence
            if (!/[.!?]\s*$/.test(chunkText)) {
                throw new Error(`Chunk ${i} does not end with a complete sentence`);
            }

            // 2. Validate chunk length
            if (chunkText.length > maxChunkLength) {
                throw new Error(`Chunk ${i} exceeds maximum length`);
            }

            // 3. Check if chunk starts/ends with partial words
            if (prevChar && /\w/.test(prevChar)) {
                throw new Error(`Chunk ${i} boundaries split a word: prevChar="${prevChar}"`);
            }
            if (nextChar && /\w/.test(nextChar)) {
                throw new Error(`Chunk ${i} boundaries split a word: nextChar="${nextChar}"`);
            }

            // 4. Validate word boundaries
            const cleanLastWord = chunk.lastWord.replace(/[.!?]$/, '');
            if (actualFirstWord !== chunk.firstWord || actualLastWord !== cleanLastWord) {
                throw new Error(`Chunk ${i} boundary validation failed: expected "${chunk.firstWord}"..."${cleanLastWord}", got "${actualFirstWord}"..."${actualLastWord}"`);
            }

            // 5. Validate chunk sequence
            if (i > 0) {
                const prevChunk = chunks[i - 1];
                if (chunk.startIndex !== prevChunk.endIndex) {
                    throw new Error(`Chunk ${i} does not start where previous chunk ended`);
                }
            } else if (chunk.startIndex !== 0) {
                throw new Error('First chunk must start at index 0');
            }

            // 6. Validate start of next chunk if this isn't the last chunk
            if (i < chunks.length - 1) {
                const nextChunkStart = text.slice(chunk.endIndex).match(/^\s*(\w+)/);
                if (!nextChunkStart || nextChunkStart[1] !== chunks[i + 1].firstWord) {
                    throw new Error(`Next chunk should start with "${chunks[i + 1].firstWord}" but found "${nextChunkStart ? nextChunkStart[1] : 'nothing'}"`);
                }
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