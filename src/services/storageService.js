// In-memory storage implementation
let results = [];

export function saveResult(result) {
    results.push(result);
    return result;
}

export function getResults() {
    return results;
}

export function clearResults() {
    results = [];
}
