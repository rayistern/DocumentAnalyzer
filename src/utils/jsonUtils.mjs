export function cleanJsonResponse(text) {
    // Find the first { and last } to extract just the JSON part
    const startIndex = text.indexOf('{');
    const endIndex = text.lastIndexOf('}') + 1;
    
    if (startIndex === -1 || endIndex === 0) {
        throw new Error('No JSON object found in response');
    }
    
    let cleaned = text.slice(startIndex, endIndex);
    
    // Handle Hebrew text by replacing Hebrew quotes with standard ones
    cleaned = cleaned
        .replace(/[""]/g, '"')  // Replace curly quotes with straight quotes
        .replace(/['']/g, "'")  // Replace curly apostrophes with straight ones
        .replace(/[\u200E\u200F\u202A-\u202E]/g, ''); // Remove Hebrew directional formatting
    
    return cleaned;
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
        // Remove duplicate normalization since it's already done in cleanJsonResponse
        return JSON.parse(cleaned);
    } catch (error) {
        console.warn('Failed to parse JSON response. Using empty default.');
        console.warn('Error:', error.message);
        console.warn('Error position:', error.message.match(/position (\d+)/)?.[1]);
        const errorPos = parseInt(error.message.match(/position (\d+)/)?.[1]);
        if (errorPos) {
            const context = cleaned.substring(Math.max(0, errorPos - 20), errorPos + 20);
            console.warn('Context around error:', context);
        }
        // Return a basic structure that won't break the code
        return { textToRemove: [] };
    }
} 