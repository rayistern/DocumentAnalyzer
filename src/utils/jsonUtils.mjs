import { setupProcessTimeout } from '../config.mjs';

export function cleanJsonResponse(text) {
    // Find the actual JSON content
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    if (start === -1 || end === 0) return text;


// Set up the global timeout for all processes
setupProcessTimeout();

    
    return text.slice(start, end);
}

/**
 * Extracts chunks from a string representation of JSON when standard parsing fails.
 * 
 * This function is specifically designed to handle cases where Hebrew text with
 * embedded quotes causes JSON.parse() to fail. It uses regex patterns to extract
 * chunk objects and their properties from a string representation of JSON.
 * 
 * @param {string} jsonText - The string representation of JSON to extract chunks from
 * @returns {Object} An object containing the extracted chunks and remainder flag
 */
export function extractChunksFromString(jsonText) {
    console.log("[HEBREW-HANDLING] Attempting to extract chunks via string-based approach");
    const chunks = [];
    
    // Match chunk objects in the string
    const chunkRegex = /{[^{}]*?"startIndex"[^{}]+?"endIndex"[^{}]+?}/g;
    const chunkMatches = jsonText.match(chunkRegex) || [];
    
    // Process each matched chunk
    chunkMatches.forEach(chunkStr => {
        // Extract startIndex
        let startIndexMatch = chunkStr.match(/"startIndex"\s*:\s*(\d+)/);
        let startIndex = startIndexMatch ? parseInt(startIndexMatch[1]) : null;
        
        // Extract endIndex
        let endIndexMatch = chunkStr.match(/"endIndex"\s*:\s*(\d+)/);
        let endIndex = endIndexMatch ? parseInt(endIndexMatch[1]) : null;

        // Extract firstWords if available
        let firstWordsMatch = chunkStr.match(/"firstWords"\s*:\s*"([^"]*)"/);
        let firstWords = firstWordsMatch ? firstWordsMatch[1] : '';

        // Extract lastWords if available
        let lastWordsMatch = chunkStr.match(/"lastWords"\s*:\s*"([^"]*)"/);
        let lastWords = lastWordsMatch ? lastWordsMatch[1] : '';
        
        if (startIndex !== null && endIndex !== null) {
                        chunks.push({
                            startIndex,
                            endIndex,
                            firstWords,
                            lastWords
                        });
        }
    });
    
    // Extract remainder flag if present
    let remainderMatch = jsonText.match(/"remainder"\s*:\s*(true|false)/);
    let remainder = remainderMatch ? (remainderMatch[1] === 'true') : undefined;
    
    if (remainder !== undefined) {
        console.log(`[HEBREW-HANDLING] Extracted remainder flag: ${remainder}`);
        }
        
        return { 
            chunks,
            remainder
        };
}

/**
 * Creates a single document chunk as a fallback when all parsing methods fail.
 * 
 * @param {string} text - The full document text
 * @returns {Object} An object containing a single chunk spanning the entire document
 */
export function createSingleDocumentChunk(text) {
    console.log("[HEBREW-HANDLING] Creating single document chunk as fallback");
    return {
        chunks: [{
            startIndex: 1,
            endIndex: text.length,
            content: text,
            firstWords: text.substring(0, Math.min(30, text.length)),
            lastWords: text.substring(Math.max(0, text.length - 30))
        }]
    };
}

/**
 * Parses JSON response from LLM with enhanced handling for Hebrew text.
 * 
 * This function implements a multi-layered fallback approach to handle
 * Hebrew text with embedded quotes that can break standard JSON parsing:
 * 
 * 1. Attempts standard JSON.parse on the response first
 * 2. If that fails, tries to extract just the JSON part from the response
 * 3. If that fails, falls back to regex-based string extraction
 * 4. If all parsing attempts fail, creates a single chunk for the entire text
 * 
 * @param {string} jsonResponseText - The response text from the LLM
 * @param {string} cleanedText - The cleaned input text sent to the LLM
 * @returns {Object} Parsed response with chunks
 */
export function parseJsonResponse(jsonResponseText, cleanedText) {
    let parsedResponse;
    
    // First attempt: Try standard JSON.parse
    try {
        parsedResponse = JSON.parse(jsonResponseText);
        console.log("[HEBREW-HANDLING] Successfully parsed response with standard JSON.parse");
        return parsedResponse;
    } catch (error) {
        console.log("[HEBREW-HANDLING] Standard JSON parsing failed:", error.message);
    }
    
    // Second attempt: Extract JSON part and try to parse
    try {
        const extractedJson = cleanJsonResponse(jsonResponseText);
        if (extractedJson) {
            parsedResponse = JSON.parse(extractedJson);
            console.log("[HEBREW-HANDLING] Successfully parsed extracted JSON portion");
            return parsedResponse;
        }
    } catch (error) {
        console.log("[HEBREW-HANDLING] Extracted JSON parsing failed:", error.message);
    }
    
    // Third attempt: Fallback to string-based extraction
    console.log("[HEBREW-HANDLING] Attempting string-based chunk extraction");
    const extractedChunks = extractChunksFromString(jsonResponseText);
    
    if (extractedChunks.chunks && extractedChunks.chunks.length > 0) {
        console.log(`[HEBREW-HANDLING] Successfully extracted ${extractedChunks.chunks.length} chunks using string-based approach`);
        return extractedChunks;
    }
    
    // Final fallback: Create a single document chunk
    console.log("[HEBREW-HANDLING] All parsing attempts failed. Creating single document chunk.");
    return createSingleDocumentChunk(cleanedText);
} 