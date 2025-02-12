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

            console.log(`\nProcessing ${filename}...`);
            // ... rest of existing processing code ...
        } catch (error) {
            console.error(`Error processing ${file}:`, error.message);
        }
    }
} 