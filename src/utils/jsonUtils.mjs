export function cleanJsonResponse(text) {
    // Find the actual JSON content
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    if (start === -1 || end === 0) return text;
    
    return text.slice(start, end);
}

export function parseJsonResponse(text) {
    try {
        const cleaned = cleanJsonResponse(text);
        return JSON.parse(cleaned);
    } catch (error) {
        console.error('Failed to parse JSON:', error.message);
        return { textToRemove: [] };
    }
} 