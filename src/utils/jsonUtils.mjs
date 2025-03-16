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

// Function to sanitize Hebrew text for safe JSON parsing
function sanitizeHebrewTextForJson(jsonText) {
    // Extract string values inside JSON to sanitize them
    const sanitized = jsonText.replace(/"([^"]*?)"/g, (match, capturedText) => {
        // Escape any unescaped quotes in the Hebrew text (like כ"א)
        const escaped = capturedText.replace(/([^\\])"/g, '$1\\"');
        return `"${escaped}"`;
    });
    
    return sanitized;
}

export function parseJsonResponse(text) {
    try {
        const cleaned = cleanJsonResponse(text);
        // Try parsing directly first
        try {
            return JSON.parse(cleaned);
        } catch (initialError) {
            // If direct parsing fails, try with sanitization
            console.log('Initial JSON parsing failed, attempting to sanitize Hebrew text...');
            const sanitized = sanitizeHebrewTextForJson(cleaned);
            return JSON.parse(sanitized);
        }
    } catch (error) {
        console.error('Failed to parse JSON:', error.message);
        // Log the problematic text for debugging
        console.error('Problematic JSON text:', text.substring(0, 200) + '...');
        return { textToRemove: [] };
    }
} 