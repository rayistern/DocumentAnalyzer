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

// Improved function to handle Hebrew text with quotation marks in JSON
function sanitizeHebrewJson(jsonText) {
    // More advanced parsing - manually extract and fix each field
    try {
        // Try a series of increasingly aggressive fixes
        
        // 1. First try: Properly escape quotes in Hebrew text
        let fixedText = jsonText.replace(/"(firstWords|lastWords)":\s*"([^"]*?)"/g, (match, field, value) => {
            // Escape any unescaped quotes in Hebrew text
            const escaped = value.replace(/([^\\])"/g, '$1\\"').replace(/^"/g, '\\"');
            return `"${field}": "${escaped}"`;
        });
        
        // Try parsing with proper escaping
        try {
            const result = JSON.parse(fixedText);
            console.log('Successfully parsed JSON with quote escaping');
            return result;
        } catch (e) {
            console.log('Escaping quotes failed, trying more aggressive methods...');
            
            // 2. Second try: Strip all quotes from Hebrew fields
            fixedText = jsonText.replace(/"(firstWords|lastWords)":\s*"([^"]*?)"/g, (match, field, value) => {
                // Remove all quotes completely (more aggressive approach)
                const sanitized = value.replace(/"/g, '');
                return `"${field}": "${sanitized}"`;
            });
            
            try {
                const result = JSON.parse(fixedText);
                console.log('Successfully parsed JSON with quote removal');
                return result;
            } catch (e2) {
                console.log('Quote removal failed, trying to extract chunks directly...');
                
                // 3. Third try: Directly extract chunks array
                if (fixedText.includes('"chunks"')) {
                    const chunksMatch = fixedText.match(/"chunks"\s*:\s*\[([\s\S]*?)\]/);
                    if (chunksMatch) {
                        const chunks = [];
                        const chunkRegex = /{([^{}]*)}/g;
                        let chunkMatch;
                        
                        while ((chunkMatch = chunkRegex.exec(chunksMatch[1])) !== null) {
                            // Process each chunk independently
                            try {
                                // Try multiple cleaning approaches for each chunk
                                const chunkText = '{' + chunkMatch[1] + '}';
                                
                                // First try escaping quotes
                                try {
                                    const cleanedChunk = chunkText.replace(/"(firstWords|lastWords)":\s*"([^"]*)"/g, (m, field, val) => {
                                        const escaped = val.replace(/([^\\])"/g, '$1\\"').replace(/^"/g, '\\"');
                                        return `"${field}": "${escaped}"`;
                                    });
                                    const chunk = JSON.parse(cleanedChunk);
                                    chunks.push(chunk);
                                    continue;
                                } catch (chunkError) {
                                    // If escaping fails, try removing quotes
                                    const cleanChunk = chunkText.replace(/"(firstWords|lastWords)":\s*"([^"]*)"/g, (m, field, val) => {
                                        const cleanVal = val.replace(/"/g, '');
                                        return `"${field}": "${cleanVal}"`;
                                    });
                                    
                                    const chunk = JSON.parse(cleanChunk);
                                    chunks.push(chunk);
                                }
                            } catch (err) {
                                console.warn('Failed to parse chunk after multiple attempts:', err.message);
                                // Continue with next chunk
                            }
                        }
                        
                        if (chunks.length > 0) {
                            console.log(`Successfully extracted ${chunks.length} chunks via manual parsing`);
                            return { chunks };
                        }
                    }
                }
            }
        }
        
        // Return the fixed text as a last resort
        return fixedText;
    } catch (err) {
        console.error('Error in sanitization:', err);
        return jsonText; // Return original if sanitization fails
    }
}

export function parseJsonResponse(text) {
    try {
        // First, extract just the JSON part
        const cleaned = cleanJsonResponse(text);
        
        // Try parsing directly first
        try {
            return JSON.parse(cleaned);
        } catch (initialError) {
            console.log('Initial JSON parsing failed, attempting sanitization...');
            
            // Try manual sanitization for Hebrew text
            try {
                const sanitized = sanitizeHebrewJson(cleaned);
                console.log('Sanitized JSON (first 200 chars):', sanitized.substring(0, 200));
                
                // Try parsing the sanitized text
                return JSON.parse(sanitized);
            } catch (sanitizeError) {
                console.error('Sanitization failed:', sanitizeError.message);
                
                // Last resort: try a more aggressive approach - manually build the JSON
                console.log('Attempting manual JSON extraction...');
                
                // Extract chunks array using regex
                const chunksMatch = cleaned.match(/"chunks"\s*:\s*\[([\s\S]*?)\]/);
                if (chunksMatch) {
                    const chunksData = chunksMatch[1];
                    const chunks = [];
                    
                    // Extract individual chunk objects
                    const chunkRegex = /{([^{}]*)}/g;
                    let chunkMatch;
                    
                    while ((chunkMatch = chunkRegex.exec(chunksData)) !== null) {
                        try {
                            const chunkStr = '{' + chunkMatch[1] + '}';
                            // Clean up the chunk data
                            const cleanChunk = chunkStr
                                .replace(/"(firstWords|lastWords)":\s*"([^"]*)"/g, (m, field, val) => 
                                    `"${field}": "${val.replace(/"/g, '')}"`);
                            
                            const chunk = JSON.parse(cleanChunk);
                            chunks.push(chunk);
                        } catch (e) {
                            console.warn('Failed to parse individual chunk:', e.message);
                        }
                    }
                    
                    if (chunks.length > 0) {
                        return { chunks };
                    }
                }
                
                // If all else fails, return empty
                console.error('All JSON parsing attempts failed');
                return { chunks: [] };
            }
        }
    } catch (error) {
        console.error('Failed to parse JSON:', error.message);
        console.error('Problematic JSON text:', text.substring(0, 200) + '...');
        return { chunks: [] };
    }
} 