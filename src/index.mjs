#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile } from './services/openaiService.mjs';
import { readTextFile } from './utils/fileReader.mjs';
import { getAnalysisByType } from './services/supabaseService.mjs';

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
    .description('Process multiple text files through OpenAI API')
    .argument('<pattern>', 'glob pattern for files to process (e.g. "*.txt" or "docs/*.pdf")')
    .option('-t, --type <type>', 'analysis type (sentiment|summary|chunk)', 'summary')
    .option('-m, --max-chunk-length <length>', 'maximum length of chunks when using chunk type', '2000')
    .action(async (pattern, options) => {
        try {
            const glob = await import('glob');
            const files = await glob.glob(pattern);
            
            if (files.length === 0) {
                console.log('No files found matching pattern:', pattern);
                return;
            }

            console.log(`Found ${files.length} files to process`);
            for (const filepath of files) {
                try {
                    console.log(`\nProcessing ${filepath}...`);
                    const content = await readTextFile(filepath);
                    const result = await processFile(content, options.type, filepath, options.maxChunkLength);
                    console.log(`Completed ${filepath}`);
                } catch (error) {
                    console.error(`Error processing ${filepath}:`, error.message);
                }
            }
            console.log('\nBatch processing complete');
        } catch (error) {
            console.error('Batch processing error:', error.message);
            process.exit(1);
        }
    });

program.parse();