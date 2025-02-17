export function cleanJsonResponse(text) {
    // Normalize all special characters that could break JSON
    let cleaned = text
        .replace(/[""]/g, '"')  // Hebrew quotes
        .replace(/['']/g, "'")  // Hebrew apostrophes
        .replace(/[\u0591-\u05C7]/g, '') // Hebrew vowel marks
        .replace(/[\u200E\u200F\u202A-\u202E]/g, '') // Directional formatting
        .replace(/[״]/g, '"')  // Additional Hebrew quotes
        .replace(/[׳]/g, "'"); // Additional Hebrew apostrophes
    
    // Try parsing with no processing first
    try {
        return cleaned;
    } catch (error) {
        // If that fails, try removing markdown
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```json\n/, '').replace(/\n```$/, '');
        }
        return cleaned;
    }
}

export function parseJsonResponse(text) {
    // Log the raw response first
    console.log('\nRaw LLM Response:');
    console.log('----------------------------------------');
    console.log(text);
    console.log('----------------------------------------\n');
    
    try {
        const cleaned = cleanJsonResponse(text);
        console.log('Cleaned JSON:');
        console.log(cleaned);
        return JSON.parse(cleaned);
    } catch (error) {
        console.error('Failed to parse LLM response as JSON:', error.message);
        console.error('Raw content:', text);
        return { textToRemove: [] };
    }
} 