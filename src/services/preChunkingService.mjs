/**
 * Divides a document into fixed-size pre-chunks for initial processing
 * 
 * This is the first step in document processing. It breaks a large document
 * into smaller, manageable pieces that can be processed sequentially.
 * 
 * These pre-chunks are NOT semantic divisions - they're just fixed-size
 * segments that serve as a starting point for the LLM to create meaningful chunks.
 * 
 * Important: Text continuity across pre-chunks is maintained through the remainder
 * mechanism in the main processing loop, not here. This function simply creates
 * the initial divisions.
 * 
 * @param {string} text - The full document text
 * @param {number} maxChunkSize - Maximum size for each pre-chunk
 * @returns {Array} Array of pre-chunks with position information
 */
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

// Global timeout setting in hours
const GLOBAL_TIMEOUT_HOURS = 10;

// Add automatic timeout function
function setupProcessTimeout(hours = GLOBAL_TIMEOUT_HOURS) {
    const timeoutMs = hours * 60 * 60 * 1000; // Convert hours to milliseconds
    console.log(`\n[${new Date().toISOString()}] ⏱️ Setting up automatic timeout after ${hours} hours`);
    
    setTimeout(() => {
        console.log(`\n[${new Date().toISOString()}] ⏱️ AUTOMATIC TIMEOUT TRIGGERED after ${hours} hours`);
        console.log(`[${new Date().toISOString()}] Process is being terminated to prevent runaway execution`);
        process.exit(0);
    }, timeoutMs);
}

// Set up the global timeout for all processes
setupProcessTimeout();


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