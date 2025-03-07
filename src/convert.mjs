#!/usr/bin/env node

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


import { Command } from 'commander';
import { batchConvert } from './utils/documentConverter.mjs';

const program = new Command();

program
    .name('document-converter')
    .description('Convert documents to text files')
    .version('1.0.0');

program
    .argument('<pattern>', 'glob pattern for files to convert (e.g. "*.docx" or "docs/*.doc")')
    .option('-o, --output <dir>', 'output directory for converted files', 'converted')
    .action(async (pattern, options) => {
        try {
            const results = await batchConvert(pattern, options.output);
            if (results) {
                const successful = results.filter(r => r.success).length;
                const failed = results.filter(r => !r.success).length;
                console.log(`\nConversion complete: ${successful} succeeded, ${failed} failed`);
            }
        } catch (error) {
            console.error('Conversion error:', error.message);
            process.exit(1);
        }
    });

program.parse(); 