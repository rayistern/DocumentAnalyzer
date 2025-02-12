export function cleanJsonResponse(text) {
    console.log('\nRaw response before cleaning:', text);
    const cleaned = text.replace(/```[\s\S]*?```/g, match => {
        // Extract content between backticks, removing the first line (```json)
        const content = match.split('\n').slice(1, -1).join('\n');
        return content;
    });
    console.log('\nCleaned response:', cleaned);
    return cleaned;
}

export function parseJsonResponse(text) {
    try {
        const cleaned = cleanJsonResponse(text);
        return JSON.parse(cleaned);
    } catch (error) {
        console.error('\nJSON Parse Error:', error.message);
        console.error('Failed to parse at position:', error.message.match(/position (\d+)/)?.[1]);
        console.error('Text around error:', cleaned.slice(Math.max(0, error.message.match(/position (\d+)/)?.[1] - 50), 
                                                        Math.min(cleaned.length, error.message.match(/position (\d+)/)?.[1] + 50)));
        throw error;
    }
} 