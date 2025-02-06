export const OPENAI_SETTINGS = {
    model: "gpt-4o",  // newest model as of May 13, 2024
    defaultMaxChunkLength: 2000,
};

export const OPENAI_PROMPTS = {
    summarize: {
        role: "system",
        content: "Summarize the following text and provide the result in JSON format with 'summary' and 'keyPoints' fields."
    },
    sentiment: {
        role: "system",
        content: "Analyze the sentiment of the text and provide a JSON response with 'sentiment' (positive/negative/neutral), 'score' (1-5), and 'confidence' (0-1) fields."
    },
    chunk: {
        role: "user",
        content: (maxChunkLength) => `Divide the following text into chunks following these strict rules:
            1. Each chunk MUST end with a complete sentence (ending with ., !, or ?)
            2. Never split in the middle of a sentence
            3. Keep each chunk under ${maxChunkLength} characters
            4. Start each chunk at the beginning of a sentence
            5. Record the exact first and last complete words of each chunk
            6. The first chunk MUST start at index 1
            7. Each subsequent chunk MUST start right after the previous chunk's ending punctuation
            8. There MUST NOT be any gaps or overlaps between chunks
            9. Include all punctuation in the chunks

            For example:
            Given text: "The cat sat on the mat. The dog ran fast. Birds flew high in the sky."

            Return on a valid JSON in the following exact format (no preface):
            {
                "chunks": [
                    {
                        "startIndex": 1,
                        "endIndex": 23,
                        "firstWord": "The",
                        "lastWord": "mat."
                    },
                    {
                        "startIndex": 24,
                        "endIndex": 41,
                        "firstWord": "The",
                        "lastWord": "fast."
                    },
                    {
                        "startIndex": 42,
                        "endIndex": 70,
                        "firstWord": "Birds",
                        "lastWord": "sky."
                    }
                ]
            }`
    }
};