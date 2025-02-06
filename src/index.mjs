#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile } from './services/openaiService.mjs';
import { saveResult, getResults, getDocumentChunks } from './services/storageService.mjs';
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
    .option('-t, --type <type>', 'analysis type (sentiment|summary|chunk)', 'summary')
    .option('-m, --max-chunk-length <length>', 'maximum length of chunks when using chunk type', '2000')
    .action(async (filepath, options) => {
        try {
            console.log('Reading file...');
            const content = await readTextFile(filepath);

            console.log('Processing with OpenAI...');
            const result = await processFile(content, options.type, options.maxChunkLength);

            console.log('Storing result...');
            const savedResult = await saveResult({
                filepath,
                type: options.type,
                content: result,
                originalText: content,
                warnings: result.warnings
            });

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
    .description('List all processed documents and their chunks')
    .action(async () => {
        try {
            const results = await getResults();
            console.log('Processed Documents:');
            Object.values(results).forEach(doc => {
                console.log(`\nDocument: ${doc.filepath}`);
                console.log(`Total Length: ${doc.totalLength}`);
                console.log(`Created: ${doc.createdAt}`);
                console.log('Chunks:', doc.chunks.length);
                doc.chunks.forEach((chunk, i) => {
                    console.log(`  ${i + 1}. ${chunk.firstWord}...${chunk.lastWord} (${chunk.endIndex - chunk.startIndex} chars)`);
                });
            });
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program.parse();