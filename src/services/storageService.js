import { storageLogger as logger } from './loggingService.mjs';

// In-memory storage implementation
let results = [];

export async function saveResult(result) {
    try {
        await logger.info('Saving result', { 
            filepath: result.filepath,
            type: result.type,
            contentLength: result.content ? JSON.stringify(result.content).length : 0
        });

        results.push(result);
        return result;
    } catch (error) {
        await logger.error('Failed to save result', error, { filepath: result.filepath });
        throw error;
    }
}

export async function getResults() {
    try {
        await logger.info('Retrieving all results', { count: results.length });
        return results;
    } catch (error) {
        await logger.error('Failed to retrieve results', error);
        throw error;
    }
}

export async function clearResults() {
    try {
        const count = results.length;
        results = [];
        await logger.info('Cleared all results', { clearedCount: count });
    } catch (error) {
        await logger.error('Failed to clear results', error);
        throw error;
    }
}