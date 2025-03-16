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

// Extract chunks using pure string manipulation without relying on JSON parsing
function extractChunksFromString(jsonText) {
    console.log('Using string-based chunk extraction approach');
    
    try {
        const chunks = [];
        // Match each chunk object pattern including potential quotes in Hebrew text
        const chunkPattern = /{[^{]*?"startIndex"[^{]*?"endIndex"[^{]*?"firstWords"[^{]*?"lastWords"[^{]*?}/g;
        
        // Find all chunks
        const matchedChunks = jsonText.match(chunkPattern);
        
        if (!matchedChunks) {
            console.log('No chunks matched with string pattern');
            return { chunks: [] };
        }
        
        console.log(`Found ${matchedChunks.length} chunks via string pattern matching`);
        
        matchedChunks.forEach((chunkText, index) => {
            try {
                // Extract individual fields with regex - safer than JSON parsing
                const startIndexMatch = chunkText.match(/"startIndex"\s*:\s*(\d+)/);
                const endIndexMatch = chunkText.match(/"endIndex"\s*:\s*(\d+)/);
                const firstWordsMatch = chunkText.match(/"firstWords"\s*:\s*"([^"]*)"/);
                const lastWordsMatch = chunkText.match(/"lastWords"\s*:\s*"([^"]*)"/);
                
                if (startIndexMatch && endIndexMatch) {
                    const startIndex = parseInt(startIndexMatch[1], 10);
                    const endIndex = parseInt(endIndexMatch[1], 10);
                    
                    // Only include chunk if we have valid start and end positions
                    if (!isNaN(startIndex) && !isNaN(endIndex) && startIndex > 0 && endIndex >= startIndex) {
                        // Extract firstWords and lastWords, removing any problematic quotes
                        let firstWords = firstWordsMatch ? firstWordsMatch[1].replace(/\\"/g, '') : '';
                        let lastWords = lastWordsMatch ? lastWordsMatch[1].replace(/\\"/g, '') : '';
                        
                        chunks.push({
                            startIndex,
                            endIndex,
                            firstWords,
                            lastWords
                        });
                    }
                }
            } catch (err) {
                console.warn(`Error processing chunk ${index}:`, err.message);
            }
        });
        
        // Also try to extract the remainder flag
        let remainder = undefined;
        const remainderMatch = jsonText.match(/"remainder"\s*:\s*(true|false)/);
        if (remainderMatch) {
            remainder = remainderMatch[1] === 'true';
            console.log(`Extracted remainder flag: ${remainder}`);
        }
        
        return { 
            chunks,
            remainder
        };
    } catch (err) {
        console.error('Error in string-based chunk extraction:', err);
        return { chunks: [] };
    }
}

// Create a single chunk for the entire document as fallback
function createSingleDocumentChunk(originalText) {
    console.log('Creating a single chunk for the entire document as fallback');
    
    // Try to find a few words at the beginning and end
    const firstFewWords = originalText.trim().split(/\s+/).slice(0, 3).join(' ');
    
    // Get last few words, being careful with splitting
    const words = originalText.trim().split(/\s+/);
    const lastFewWords = words.length > 3 ? words.slice(-3).join(' ') : words.join(' ');
    
    return {
        chunks: [{
            startIndex: 1,
            endIndex: originalText.length,
            firstWords: firstFewWords,
            lastWords: lastFewWords
        }]
    };
}

export function parseJsonResponse(text) {
    // Save the original text for possible fallback
    const originalText = text;
    
    try {
        // First, extract just the JSON part
        const cleaned = cleanJsonResponse(text);
        
        // Try standard JSON parsing first
        try {
            return JSON.parse(cleaned);
        } catch (initialError) {
            console.log('Initial JSON parsing failed:', initialError.message);
            
            // Step 1: Try escaping quotes in Hebrew text first (less destructive)
            try {
                const escapedText = cleaned.replace(/"(firstWords|lastWords)":\s*"([^"]*?)"/g, (match, field, value) => {
                    // Properly escape quotes in Hebrew text rather than removing them
                    const escaped = value.replace(/([^\\])"/g, '$1\\"').replace(/^"/g, '\\"');
                    return `"${field}": "${escaped}"`;
                });
                
                return JSON.parse(escapedText);
            } catch (escapeError) {
                console.log('Quote escaping failed, trying quote removal...');
                
                // Step 2: If escaping fails, try removing quotes entirely
                try {
                    // Handle quotes in Hebrew text by removing them
                    const fixedText = cleaned.replace(/"(firstWords|lastWords)":\s*"([^"]*?)"/g, (match, field, value) => {
                        // Remove all quotes inside the field value
                        const sanitized = value.replace(/"/g, '');
                        return `"${field}": "${sanitized}"`;
                    });
                    
                    // Try parsing the sanitized text as JSON
                    return JSON.parse(fixedText);
                } catch (sanitizeError) {
                    console.log('JSON sanitization failed:', sanitizeError.message);
                    
                    // Only if all JSON parsing approaches fail, use string extraction as a complete fallback
                    if (cleaned.includes('"chunks"') && (cleaned.includes('"startIndex"') || cleaned.includes('"firstWords"'))) {
                        console.log('All JSON parsing failed, falling back to string extraction');
                        const extractedResult = extractChunksFromString(cleaned);
                        
                        // If string extraction found chunks, return them
                        if (extractedResult.chunks && extractedResult.chunks.length > 0) {
                            return extractedResult;
                        }
                    }
                    
                    // If we still have no chunks, create one chunk for the whole document
                    console.log('No chunks found with any method, treating document as a single chunk');
                    return createSingleDocumentChunk(originalText);
                }
            }
        }
    } catch (error) {
        console.error('Failed to parse JSON:', error.message);
        console.error('Problematic JSON text:', text.substring(0, 200) + '...');
        
        // Last resort - if we detect it's a chunk format but can't parse it any other way
        if (text.includes('"chunks"') && (text.includes('"startIndex"') || text.includes('"firstWords"'))) {
            const extractedResult = extractChunksFromString(text);
            
            // If string extraction found chunks, return them
            if (extractedResult.chunks && extractedResult.chunks.length > 0) {
                return extractedResult;
            }
        }
        
        // Final fallback - create one chunk for the whole document
        return createSingleDocumentChunk(originalText);
    }
} 