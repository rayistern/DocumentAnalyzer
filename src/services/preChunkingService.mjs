export function preChunkText(text, maxChunkSize = 1500) {
    // If text is shorter than maxChunkSize, return as single chunk
    if (text.length <= maxChunkSize) {
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
        
        chunks.push({
            text: text.slice(currentPosition, endPosition),
            isComplete: endPosition === text.length,
            startPosition: currentPosition + 1,
            endPosition
        });

        currentPosition = endPosition;
    }

    return chunks;
}

export function shouldUseSimplifiedPrompt(text, maxChunkSize = 1500) {
    // Use simplified prompt if:
    // 1. Text is shorter than maxChunkSize
    // 2. Text ends with a sentence terminator
    return text.length <= maxChunkSize && text.trim().match(/[.!?]$/);
} 