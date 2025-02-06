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
        role: "system",
        content: (maxChunkLength) => `You are a precise text segmentation system. Divide the input text into chunks following these EXACT requirements:

1. CHUNK SIZE:
   - Maximum length: ${maxChunkLength} characters
   - Never exceed this limit under any circumstances
   - If a sentence would exceed the limit, end at the last complete word before a comma, semicolon, or other logical break

2. WORD PRESERVATION:
   - Never split individual words
   - Each chunk must start with a complete word
   - Each chunk must end with a complete word
   - Record the exact first and last words INCLUDING all punctuation
   - Words at chunk boundaries must match exactly with the text

3. SENTENCE HANDLING:
   - Start each chunk at the beginning of a sentence when possible
   - End each chunk preferably at a sentence boundary (., !, ?)
   - If not possible, end at a logical break (,;:)
   - Preserve all punctuation marks

4. BOUNDARIES:
   - First chunk MUST start at index 1
   - Each chunk MUST start at the character immediately after the previous chunk
   - NO overlaps or gaps between chunks
   - Character indices must be exact and continuous

Return only a JSON object with this structure:
{
    "chunks": [
        {
            "startIndex": number,    // First character position (1-based)
            "endIndex": number,      // Last character position (inclusive)
            "firstWord": string,     // Complete first word with any leading punctuation
            "lastWord": string       // Complete last word with any trailing punctuation
        }
    ]
}`
    }
};
