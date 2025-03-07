import { checkDocumentExists } from '../services/dbService.mjs';

async function processBatch(files, options) {
    for (const file of files) {
        try {
            // Get just the filename without the path
            const filename = path.basename(file);
            
            // Check if file exists in document_sources
            const exists = await checkDocumentExists(filename);
            if (exists) {
                console.log(`Skipping ${filename} - already processed`);
                continue;
            }

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


            console.log(`\nProcessing ${filename}...`);
            // ... rest of existing processing code ...
        } catch (error) {
            console.error(`Error processing ${file}:`, error.message);
        }
    }
} 