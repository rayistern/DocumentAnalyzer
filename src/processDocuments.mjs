#!/usr/bin/env node

import { convertToText } from './utils/documentConverter.mjs';
import { processFile } from './services/openaiService.mjs';
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';

const INPUT_DIR = 'inputFiles';
const PROCESSED_DIR = 'processedFiles';
const TEMP_DIR = 'tempTxt';

async function ensureDirectories() {
    await fs.mkdir(INPUT_DIR, { recursive: true });
    await fs.mkdir(PROCESSED_DIR, { recursive: true });
    await fs.mkdir(TEMP_DIR, { recursive: true });
}

async function processDocuments(options) {
    try {
        await ensureDirectories();
        
        // Get all files from input directory
        const files = await fs.readdir(INPUT_DIR);
        console.log(`Found ${files.length} files to process`);
        console.log(`Using chunk length: ${options.maxChunkLength}`);
        
        for (const file of files) {
            const inputPath = path.join(INPUT_DIR, file);
            try {
                console.log(`\nProcessing ${file}...`);
                
                // Step 1: Convert to text if needed
                console.log('Converting to text...');
                const text = await convertToText(inputPath);
                const txtPath = path.join(TEMP_DIR, `${path.parse(file).name}.txt`);
                await fs.writeFile(txtPath, text, 'utf8');
                
                // Step 2: Clean and chunk the text
                console.log('Cleaning and chunking...');
                const result = await processFile(text, 'cleanAndChunk', file, options.maxChunkLength, options.overview);
                
                // Step 3: Move original file to processed directory
                const processedPath = path.join(PROCESSED_DIR, file);
                await fs.rename(inputPath, processedPath);
                
                console.log(`Successfully processed ${file}`);
                console.log('Chunks:', result.chunks ? result.chunks.length : 0);
                if (result.warnings && result.warnings.length > 0) {
                    console.log('Warnings:', result.warnings);
                }
            } catch (error) {
                console.error(`Error processing ${file}:`, error.message);
            }
        }
        
        // Clean up temp directory
        await fs.rm(TEMP_DIR, { recursive: true, force: true });
        
    } catch (error) {
        console.error('Processing error:', error.message);
        process.exit(1);
    }
}

const program = new Command();

program
    .name('document-processor')
    .description('Process documents from inputFiles directory')
    .option('-m, --maxChunkLength <number>', 'maximum length of each chunk', parseInt)
    .option('-o, --overview <text>', 'overview text to include in the prompt')
    .action(async (options) => {
        options.maxChunkLength = options.maxChunkLength || 2000;
        await processDocuments(options);
    });

program.parse(); 