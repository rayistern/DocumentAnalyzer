import mammoth from 'mammoth';
import fs from 'fs/promises';
import path from 'path';

export async function convertToText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    
    switch (ext) {
        case '.docx':
        case '.doc':
            return await convertWordToText(filePath);
        case '.txt':
            return await fs.readFile(filePath, 'utf8');
        default:
            throw new Error(`Unsupported file type: ${ext}`);
    }
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


async function convertWordToText(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
    } catch (error) {
        throw new Error(`Failed to convert Word document: ${error.message}`);
    }
}

export async function batchConvert(pattern, outputDir = 'converted') {
    const glob = await import('glob');
    const files = await glob.glob(pattern);
    
    if (files.length === 0) {
        console.log('No files found matching pattern:', pattern);
        return;
    }

    // Create output directory if it doesn't exist
    await fs.mkdir(outputDir, { recursive: true });
    
    console.log(`Found ${files.length} files to convert`);
    const results = [];
    
    for (const filePath of files) {
        try {
            console.log(`\nConverting ${filePath}...`);
            const text = await convertToText(filePath);
            
            // Create output filename
            const baseName = path.basename(filePath, path.extname(filePath));
            const outputPath = path.join(outputDir, `${baseName}.txt`);
            
            // Write converted text
            await fs.writeFile(outputPath, text, 'utf8');
            
            results.push({
                input: filePath,
                output: outputPath,
                success: true
            });
            
            console.log(`Converted to ${outputPath}`);
        } catch (error) {
            console.error(`Error converting ${filePath}:`, error.message);
            results.push({
                input: filePath,
                error: error.message,
                success: false
            });
        }
    }
    
    return results;
} 