export function cleanJsonResponse(text) {
    // Find the actual JSON content
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    if (start === -1 || end === 0) return text;

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