export const OPENAI_SETTINGS = {
    model: "o1-preview",  // newest model as of May 13, 2024
    defaultMaxChunkLength: 2000,
    textRemovalPositionTolerance: 5  // Maximum character difference allowed for text removal positions
};

export const OPENAI_PROMPTS = {
    summarize: {
        role: "user",
        content: "Summarize the following text and provide the result in JSON format with 'summary' and 'keyPoints' fields."
    },
    sentiment: {
        role: "user",
        content: "Analyze the sentiment of the text and provide a JSON response with 'sentiment' (positive/negative/neutral), 'score' (1-5), and 'confidence' (0-1) fields."
    },
    chunk: {
        role: "user",
        content: (maxChunkLength) => `Divide the following text into chunks and identify text to be removed, following these strict rules:
            1. Each chunk MUST end with a complete sentence (ending with ., !, or ?)
            2. Never split in the middle of a sentence
            3. Keep each chunk under ${maxChunkLength} characters
            4. Start each chunk at the beginning of a sentence
            5. Record the exact first and last complete words of each chunk
            6. The first chunk MUST start at index 1
            7. Each subsequent chunk MUST start right after the previous chunk's ending punctuation
            8. There MUST NOT be any gaps or overlaps between chunks
            9. Include all punctuation in the chunks
            10. Identify any text that should be removed, such as:
                - Page numbers and headers (e.g., "Page 1", "Chapter 1:")
                - Divider lines (e.g., "----------")
                - Headers and footers
                - Version numbers or draft markings
                - Any other non-content structural elements
            11. For each piece of text to be removed, provide its exact start and end positions

            Return a valid JSON in the following exact format (no preface):
            {
                "chunks": [
                    {
                        "startIndex": 1,
                        "endIndex": 23,
                        "firstWord": "The",
                        "lastWord": "mat.",
                        "cleanedText": "actual text without removed elements"
                    }
                ],
                "textToRemove": [
                    {
                        "text": "Page 1",
                        "startPosition": 1,
                        "endPosition": 6
                    },
                    {
                        "text": "-----------------",
                        "startPosition": 7,
                        "endPosition": 24
                    }
                ]
            }`
    }
};