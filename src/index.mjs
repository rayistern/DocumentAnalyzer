#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile } from './services/openaiService.mjs';
import { saveResult, getResults } from './services/storageService.mjs';
import { readTextFile } from './utils/fileReader.mjs';
import { systemLogger as logger } from './services/loggingService.mjs';

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
            await saveResult({
                filepath,
                type: options.type,
                content: result,
                originalText: content,
                warnings: result.warnings
            });

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

            await logger.info('Processing completed successfully', { 
                filepath,
                type: options.type,
                warnings: result.warnings?.length || 0
            });

            console.log('\nResult:', JSON.stringify(result, null, 2));
        } catch (error) {
            await logger.error('Processing failed', error, { filepath, options });
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program
    .command('list')
    .description('List all processed documents')
    .action(async () => {
        try {
            const results = await getResults();

            console.log('Processed Documents:');
            Object.values(results).forEach(doc => {
                console.log(`\nDocument: ${doc.filepath}`);
                console.log(`Type: ${doc.type}`);
                console.log(`Created: ${doc.timestamp}`);

                if (doc.content.textToRemove) {
                    console.log('Removed Elements:');
                    doc.content.textToRemove.forEach(item => {
                        console.log(`  - "${item.text}" (pos ${item.startPosition}-${item.endPosition})`);
                    });
                }

                if (doc.content.chunks) {
                    console.log('Chunks:', doc.content.chunks.length);
                    doc.content.chunks.forEach((chunk, i) => {
                        console.log(`  ${i + 1}. ${chunk.firstWord}...${chunk.lastWord} (${chunk.endIndex - chunk.startIndex + 1} chars)`);
                    });
                }
            });

            await logger.info('Document list displayed successfully', { count: results.length });
        } catch (error) {
            await logger.error('Failed to list documents', error);
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program.parse();