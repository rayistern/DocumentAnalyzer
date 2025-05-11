#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile, batchProcessFullMetadata } from './services/openaiService.mjs';
import { readTextFile } from './utils/fileReader.mjs';
import { getAnalysisByType, logAllDocumentSources, detectUnexpectedEntries, checkForDatabaseTriggers, checkForRecentActivity } from './services/supabaseService.mjs';
import { glob } from 'glob';
import path from 'path';
import { convertToText } from './utils/documentConverter.mjs';
import { checkDocumentExists, getLastProcessedDocument } from './services/dbService.mjs';
import { saveAnalysis } from './services/supabaseService.mjs';
import { setupProcessTimeout } from './config.mjs';

dotenv.config();

// Global initialization - timeout will be updated when specific commands run
setupProcessTimeout();

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
    .option('--previousDocumentId <id>', 'ID of the previous document to use for continuation')
    .option('-g, --group <n>', 'group name for the documents')
    .option('--reverse', 'process files in reverse order')
    .option('--delay <ms>', 'delay in milliseconds between processing files', '20000')
    .option('--local-only', 'only use local files, ignore database for file selection', false)
    .action(async (pattern, options) => {
        try {
            // Set up timeout specific to this process type
            setupProcessTimeout(undefined, options.type);
            
            const files = await glob(pattern);
            
            // Sort files based on the reverse flag
            if (options.reverse) {
                files.sort().reverse(); // Sort and then reverse for descending order
                console.log('Processing files in reverse order');
            } else {
                files.sort(); // Sort files in ascending order
            }
            console.log(`Found ${files.length} files matching pattern`);

            // If continuing from last processed, get the last document
            let startFromFile = null;
            if (options.continue && !options.localOnly) {
                console.log('Looking up last processed document from database...');
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
            
            // Track in-memory remainder text for continuation
            let remainderText = null;
            
            // Add batch processing sequence tracking
            console.log(`\n[${new Date().toISOString()}] 🔄 STARTING BATCH PROCESSING`);
            console.log(`[${new Date().toISOString()}] Processing type: ${options.type}`);
            console.log(`[${new Date().toISOString()}] Group: ${options.group || 'none'}`);
            console.log(`[${new Date().toISOString()}] Skip metadata: ${options.skipMetadata ? 'true' : 'false'}`);
            console.log(`[${new Date().toISOString()}] Delay between files: ${options.delay}ms`);
            console.log(`[${new Date().toISOString()}] Local only mode: ${options.localOnly ? 'ON' : 'OFF'}`);
            
            if (!options.localOnly) {
                console.log(`\n[${new Date().toISOString()}] ⚠️ WARNING: Local-only mode is OFF. The system will check the database for existing files.`);
                console.log(`[${new Date().toISOString()}] This may cause unexpected behavior if there are files in the database with the same names as local files.`);
                console.log(`[${new Date().toISOString()}] To process only local files, use the --local-only flag.\n`);
            }
            
            // Check for any unexpected entries before starting
            await detectUnexpectedEntries(null);
            
            // Check for any database triggers
            await checkForDatabaseTriggers();
            
            // Check for recent database activity
            await checkForRecentActivity();
            
            // Log current document_sources entries
            await logAllDocumentSources();
            
            // Track file processing sequence
            let fileCounter = 0;
            const totalFiles = files.length;
            
            // Helper function to delay execution
            const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
            
            for (const [idx, file] of files.entries()) {
                try {
                    fileCounter++;
                    const filename = path.basename(file);
                    const processTimestamp = new Date().toISOString();
                    
                    console.log(`\n[${processTimestamp}] 📄 FILE ${fileCounter}/${totalFiles}: ${filename}`);
                    
                    // If we haven't reached the start file yet, skip
                    if (!shouldProcess) {
                        if (filename === startFromFile) {
                            shouldProcess = true;
                            console.log(`[${processTimestamp}] Found start point: ${filename}`);
                        }
                        console.log(`[${processTimestamp}] Skipping ${filename} - before start point`);
                        continue;
                    }
                    
                    // Check if file exists in document_sources
                    console.log(`[${processTimestamp}] Checking if document exists in database...`);
                    const exists = options.localOnly 
                        ? false // Skip database check in local-only mode
                        : await checkDocumentExists(filename, options.reprocessIncomplete, options.group);
                    if (exists) {
                        console.log(`[${processTimestamp}] Skipping ${filename} - already processed in group ${options.group}`);
                        continue;
                    }

                    console.log(`\n[${processTimestamp}] ⏳ PROCESSING ${filename}...`);
                    
                    // Convert to text
                    console.log(`[${processTimestamp}] Converting to text...`);
                    const text = await convertToText(file);
                    
                    // Add clear logging about continuation status
                    console.log(`[${processTimestamp}] Continuation mode: ${options.continuation ? 'ON' : 'OFF'}`);
                    if (options.continuation && remainderText !== null) {
                        console.log(`[${processTimestamp}] Using in-memory remainder text (${remainderText.length} chars)`);
                    }
                    
                    console.log(`[${processTimestamp}] Using processing type: ${options.type}`);
                    
                    // true ⇢ mark last doc so prompts get isIncomplete flag
                    const lastDoc = !(await hasFutureProcessable(files, idx, options));

                    // Process the text
                    console.log(`[${processTimestamp}] Calling processFile function...`);
                    const result = await processFile(
                        text, 
                        options.type, 
                        filename,
                        parseInt(options.maxChunkLength),
                        options.overview,
                        options.skipMetadata,
                        options.continuation,
                        options.group,
                        null,  // previousDocumentId
                        options.continuation ? remainderText : null,
                        lastDoc
                    );

                    console.log(`[${processTimestamp}] ✅ Successfully processed ${filename}`);
                    console.log(`[${processTimestamp}] Chunks: ${result.chunks ? result.chunks.length : 0}`);
                    if (result.warnings?.length > 0) {
                        console.log(`[${processTimestamp}] Warnings:`, result.warnings);
                    }

                    // Update in-memory remainder for next file
                    if (result.remainderText) {
                        remainderText = result.remainderText;
                        console.log(`[${processTimestamp}] Stored remainder text for next file (${remainderText.length} chars)`);
                    }
                    
                    // Check for any unexpected entries that might have been created during processing
                    await detectUnexpectedEntries(filename);
                    
                    // Log document_sources after processing to track changes
                    await logAllDocumentSources();
                    
                    // Add delay between files to prevent race conditions
                    if (fileCounter < totalFiles) {
                        const delayMs = parseInt(options.delay);
                        console.log(`[${new Date().toISOString()}] 🕒 Waiting ${delayMs}ms before processing next file...`);
                        await delay(delayMs);
                    }
                } catch (error) {
                    const errorTimestamp = new Date().toISOString();
                    console.error(`[${errorTimestamp}] ❌ ERROR processing ${file}:`, error.message);
                    if (error.stack) {
                        console.error(`[${errorTimestamp}] Stack trace:`, error.stack);
                    }
                    
                    // Add delay even after errors
                    if (fileCounter < totalFiles) {
                        const delayMs = parseInt(options.delay);
                        console.log(`[${new Date().toISOString()}] 🕒 Waiting ${delayMs}ms before processing next file...`);
                        await delay(delayMs);
                    }
                }
            }
            
            console.log(`\n[${new Date().toISOString()}] 🏁 BATCH PROCESSING COMPLETE`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Batch processing error:`, error.message);
            process.exit(1);
        }
    });

program
    .command('process-metadata')
    .description('Process fullMetadata for documents')
    .argument('<ids>', 'comma-separated list of document IDs')
    .option('--reverse', 'process document IDs in reverse order')
    .action(async (ids, options) => {
        try {
            // Set up timeout specific to this process type
            setupProcessTimeout(undefined, 'process-metadata');
            
            let documentIds = ids.split(',').map(id => parseInt(id.trim()));
            
            // Sort document IDs based on the reverse flag
            if (options.reverse) {
                documentIds.reverse();
                console.log('Processing document IDs in reverse order');
            }
            
            await batchProcessFullMetadata(documentIds);
            console.log('Metadata processing complete');
        } catch (error) {
            console.error('Metadata processing error:', error.message);
            process.exit(1);
        }
    });

program
    .command('basic-embed')
    .description('Simpler embedding with direct filters (no JSON parsing)')
    .option('--table <table>', 'source table')
    .option('--column <column>', 'source column')
    .option('--id <id>', 'exact id match')
    .option('--lt <value>', 'id less than value')
    .option('--gt <value>', 'id greater than value')
    .option('--batch <size>', 'batch size', '5')
    .option('--model <model>', 'embedding model')
    .option('--group <group>', 'embedding group name', 'default')
    .action(async (options) => {
        try {
            const { basicEmbed } = await import('./batch/basicEmbed.mjs');
            await basicEmbed(options);
        } catch (error) {
            console.error('❌ Basic embedding failed:', error);
            process.exit(1);
        }
    });

program
    .command('local-embed')
    .description('Embed content and save to local files instead of Supabase')
    .option('--table <table>', 'source table')
    .option('--column <column>', 'source column')
    .option('--id <id>', 'exact id match')
    .option('--lt <value>', 'id less than value')
    .option('--gt <value>', 'id greater than value')
    .option('--output-dir <dir>', 'output directory', './embeddings')
    .option('--model <model>', 'embedding model')
    .option('--group <group>', 'embedding group name', 'default')
    .option('--provider <provider>', 'embedding provider', 'openai')
    .action(async (options) => {
        try {
            const { localEmbed } = await import('./batch/localEmbed.mjs');
            await localEmbed(options);
        } catch (error) {
            console.error('❌ Local embedding failed:', error);
            process.exit(1);
        }
    });

program
    .command('upload-embeddings')
    .description('Upload local embeddings to Supabase')
    .option('--dir <dir>', 'directory with embedding files', './embeddings')
    .option('--batch-size <size>', 'upload batch size', '20')
    .action(async (options) => {
        try {
            const { uploadEmbeddings } = await import('./batch/uploadEmbeddings.mjs');
            await uploadEmbeddings(options);
        } catch (error) {
            console.error('❌ Upload failed:', error);
            process.exit(1);
        }
    });

program.parse();

// helper ─ is there another file left to *process* (not skipped)?
async function hasFutureProcessable(files, startIdx, opts) {
  for (let j = startIdx + 1; j < files.length; j++) {
    const fn = path.basename(files[j]);
    const exists = opts.localOnly
      ? false
      : await checkDocumentExists(fn, opts.reprocessIncomplete, opts.group);
    if (!exists) return true;       // we found another real job
  }
  return false;
}