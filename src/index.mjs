#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile } from './services/openaiService.mjs';
import { saveResult, getResults } from './services/storageService.mjs';
import { readTextFile } from './utils/fileReader.mjs';

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
    .option('-t, --type <type>', 'analysis type (sentiment|summary)', 'summary')
    .action(async (filepath, options) => {
        try {
            console.log('Reading file...');
            const content = await readTextFile(filepath);

            console.log('Processing with OpenAI...');
            const result = await processFile(content, options.type);

            console.log('Storing result...');
            const savedResult = await saveResult({
                filepath,
                type: options.type,
                content: result,
                timestamp: new Date().toISOString()
            });

            console.log('Result:', result);
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program
    .command('list')
    .description('List all processed results')
    .action(async () => {
        try {
            const results = await getResults();
            console.table(results);
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program.parse();