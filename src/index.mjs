#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile } from './services/openaiService.mjs';
import { readTextFile } from './utils/fileReader.mjs';
import { getAnalysisByType } from './services/supabaseService.mjs';
import { glob } from 'glob';
import path from 'path';
import { convertToText } from './utils/documentConverter.mjs';
import { checkDocumentExists } from './services/dbService.mjs';

dotenv.config();

const program = new Command();

program
    .name('text-processor')
    .description('CLI tool to process text files through OpenAI API')
    .version('1.0.0');

program
    .command('process')
    .description('Process a text file through OpenAI API')
    .argument('<filepath>', 'path to the text file')
    .option('-t, --type <type>', 'analysis type (sentiment|summary|chunk)', 'summary')
    .option('-m, --max-chunk-length <length>', 'maximum length of chunks when using chunk type', '2000')
    .action(async (filepath, options) => {
        try {
            console.log('Reading file...');
            const content = await readTextFile(filepath);

            console.log('Processing with OpenAI...');
            const result = await processFile(content, options.type, filepath, options.maxChunkLength);

            if (result.textToRemove && result.textToRemove.length > 0) {
                console.log('\nIdentified text to remove:');
                result.textToRemove.forEach(item => {
                    console.log(`- "${item.text}" (positions ${item.startPosition}-${item.endPosition})`);
                });
            }

            if (result.warnings && result.warnings.length > 0) {
                console.log('\nValidation Warnings:');
                result.warnings.forEach(warning => console.log(warning));
            }

            console.log('\nResult:', JSON.stringify(result, null, 2));
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program
    .command('list')
    .description('List all processed documents')
    .option('-t, --type <type>', 'analysis type to list (sentiment|summary|chunk)')
    .action(async (options) => {
        try {
            const results = await getAnalysisByType(options.type);
            console.log(`Found ${results.length} documents:`);
            results.forEach(doc => {
                console.log(`\nDocument created at: ${doc.created_at}`);
                console.log('Result:', JSON.stringify(doc.result, null, 2));
            });
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program
    .command('batch')
    .description('Process multiple documents matching a glob pattern')
    .argument('<pattern>', 'glob pattern for files')
    .option('-t, --type <type>', 'processing type', 'cleanAndChunk')
    .option('-m, --maxChunkLength <number>', 'maximum length of each chunk', '2000')
    .option('-o, --overview <text>', 'overview text to include')
    .action(async (pattern, options) => {
        try {
            const files = await glob(pattern);
            console.log(`Found ${files.length} files matching pattern`);

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
                    
                    // Convert to text
                    const text = await convertToText(file);
                    
                    // Process the text
                    const result = await processFile(
                        text, 
                        options.type, 
                        filename,
                        parseInt(options.maxChunkLength),
                        options.overview
                    );

                    console.log(`Successfully processed ${filename}`);
                    console.log('Chunks:', result.chunks ? result.chunks.length : 0);
                    if (result.warnings?.length > 0) {
                        console.log('Warnings:', result.warnings);
                    }
                } catch (error) {
                    console.error(`Error processing ${file}:`, error.message);
                }
            }
        } catch (error) {
            console.error('Batch processing error:', error.message);
            process.exit(1);
        }
    });

program.parse();