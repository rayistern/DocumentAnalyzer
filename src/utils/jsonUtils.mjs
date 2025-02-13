export function cleanJsonResponse(text) {
    // First remove any markdown code blocks
    let cleaned = text.replace(/```[\s\S]*?```/g, match => {
        const lines = match.split('\n');
        // Remove the first and last lines (``` markers)
        return lines.slice(1, -1).join('\n');
    });
    
    // Remove any remaining backticks
    cleaned = cleaned.replace(/`/g, '');
    
    // Remove any leading/trailing whitespace and newlines
    cleaned = cleaned.trim();
    
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
        // Handle Hebrew text by replacing Hebrew quotes with standard ones
        const normalized = cleaned
            .replace(/[""]/g, '"')  // Replace curly quotes with straight quotes
            .replace(/['']/g, "'"); // Replace curly apostrophes with straight ones
        return JSON.parse(normalized);
    } catch (error) {
        console.warn('Failed to parse JSON response. Using empty default.');
        console.warn('Error:', error.message);
        console.warn('Cleaned text:', cleanJsonResponse(text));
        // Return a basic structure that won't break the code
        return { textToRemove: [] };
    }
} 