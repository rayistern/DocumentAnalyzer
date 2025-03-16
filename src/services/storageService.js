import { setupProcessTimeout } from '../config.mjs';

// In-memory storage implementation
let results = [];

export function saveResult(result) {
    results.push(result);
    return result;
}


// Set up the global timeout for all processes
setupProcessTimeout();


export function getResults() {
    return results;
}

export function clearResults() {
    results = [];
}
