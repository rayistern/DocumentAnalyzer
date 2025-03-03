export function preChunkText(text, maxChunkSize = 1500) {
    console.log(`\n=== Pre-Chunking Text ===`);
    console.log(`Text length: ${text.length} characters`);
    console.log(`Max chunk size: ${maxChunkSize} characters`);
    
    // If text is shorter than maxChunkSize, return as single chunk
    if (text.length <= maxChunkSize) {
        console.log(`Text fits in a single chunk, returning`);
        return [{
            text,
            isComplete: true,
            startPosition: 1,
            endPosition: text.length
        }];
    }

    const chunks = [];
    let currentPosition = 0;

    while (currentPosition < text.length) {
        const endPosition = Math.min(currentPosition + maxChunkSize, text.length);
        const chunkText = text.slice(currentPosition, endPosition);
        
        console.log(`\nCreated pre-chunk ${chunks.length + 1}:`);
        console.log(`- Start position: ${currentPosition + 1}`);
        console.log(`- End position: ${endPosition}`);
        console.log(`- Length: ${chunkText.length} characters`);
        console.log(`- First 50 chars: "${chunkText.substring(0, 50)}..."`);
        
        chunks.push({
            text: chunkText,
            isComplete: endPosition === text.length,
            startPosition: currentPosition + 1,
            endPosition
        });

        currentPosition = endPosition;
    }

    console.log(`\nCreated ${chunks.length} pre-chunks in total`);
    console.log(`=== End Pre-Chunking ===\n`);
    return chunks;
}

export function shouldUseSimplifiedPrompt(text, maxChunkSize = 1500) {
    // Use simplified prompt if:
    // 1. Text is shorter than maxChunkSize
    // 2. Text ends with a sentence terminator
    return text.length <= maxChunkSize && text.trim().match(/[.!?]$/);
} 