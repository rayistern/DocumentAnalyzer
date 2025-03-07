import fs from 'fs/promises';
import path from 'path';
import { convertToText } from './documentConverter.mjs';

export async function readTextFile(filepath) {
    try {
        const absolutePath = path.resolve(filepath);
        const ext = path.extname(filepath).toLowerCase();
        
        let content;
        if (ext === '.docx' || ext === '.doc') {
            content = await convertToText(absolutePath);
        } else {
            content = await fs.readFile(absolutePath, 'utf8');
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

        
        if (!content.trim()) {
            throw new Error('File is empty');
        }
        
        return content;
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`File not found: ${filepath}`);
        }
        throw new Error(`Error reading file: ${error.message}`);
    }
}
