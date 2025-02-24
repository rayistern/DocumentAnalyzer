#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile, batchProcessFullMetadata } from './services/openaiService.mjs';
import { readTextFile } from './utils/fileReader.mjs';
import { getAnalysisByType } from './services/supabaseService.mjs';
import { glob } from 'glob';
import path from 'path';
import { convertToText } from './utils/documentConverter.mjs';
import { checkDocumentExists, getLastProcessedDocument } from './services/dbService.mjs';

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
    .option('-s, --start-from <filename>', 'start processing from this file')
    .option('-c, --continue', 'continue from last processed document')
    .option('-r, --reprocess-incomplete', 'reprocess documents that are in processing status')
    .option('--skipMetadata', 'skip the fullMetadata processing step')
    .option('--continuation', 'treat this document as a continuation of the previous one')
    .option('--reverse', 'process files in reverse order')
    .action(async (pattern, options) => {
        try {
            const files = await glob(pattern);
            files.sort(); // Sort files in ascending order
            if (options.reverse) {
                files.reverse();
                console.log('Processing files in reverse order');
            }
            console.log(`Found ${files.length} files matching pattern`);

            // If continuing from last processed, get the last document
            let startFromFile = null;
            if (options.continue) {
                const lastDoc = await getLastProcessedDocument();
                if (lastDoc) {
                    startFromFile = path.basename(lastDoc.filename);
                    console.log(`Continuing from last processed document: ${startFromFile}`);
                }
            } else if (options.startFrom) {
                startFromFile = options.startFrom;
                console.log(`Starting from specified document: ${startFromFile}`);
            }

            // Skip files until we reach the start point
            let shouldProcess = !startFromFile;
            
            for (const file of files) {
                try {
                    const filename = path.basename(file);
                    
                    // If we haven't reached the start file yet, skip
                    if (!shouldProcess) {
                        if (filename === startFromFile) {
                            shouldProcess = true;
                            console.log(`Found start point: ${filename}`);
                        }
                        console.log(`Skipping ${filename} - before start point`);
                        continue;
                    }
                    
                    // Check if file exists in document_sources
                    const exists = await checkDocumentExists(filename, options.reprocessIncomplete);
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
                        options.overview,
                        options.skipMetadata,
                        options.continuation
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

program
    .command('process-metadata')
    .description('Process fullMetadata for documents')
    .argument('<ids>', 'comma-separated list of document IDs')
    .action(async (ids) => {
        try {
            const documentIds = ids.split(',').map(id => parseInt(id.trim()));
            await batchProcessFullMetadata(documentIds);
            console.log('Metadata processing complete');
        } catch (error) {
            console.error('Metadata processing error:', error.message);
            process.exit(1);
        }
    });

program.parse();