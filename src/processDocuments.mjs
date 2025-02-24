#!/usr/bin/env node

import { convertToText } from './utils/documentConverter.mjs';
import { processFile } from './services/openaiService.mjs';
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { checkDocumentExists } from './services/dbService.mjs';
import { checkDuplicateDocument } from './utils/deduplication.mjs';
import { saveAnalysis } from './services/supabaseService.mjs';
import { calculateContentHash } from './utils/hash.mjs';

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
        
        let previousText = ''; // Track text from previous document
        
        for (const file of files) {
            const inputPath = path.join(INPUT_DIR, file);
            try {
                // Get just the filename without the path
                const filename = path.basename(file);
                
                // Check if file exists in document_sources
                const exists = await checkDocumentExists(filename, options.reprocessIncomplete);
                if (exists) {
                    console.log(`Skipping ${filename} - already processed`);
                    continue;
                }

                console.log(`\nProcessing ${filename}...`);
                
                // Step 1: Convert to text if needed
                console.log('Converting to text...');
                const text = await convertToText(inputPath);
                
                // Calculate hash and check for duplicate content immediately
                const contentHash = calculateContentHash(text);
                console.log('\n=== PROCESSING DOCUMENT ===');
                console.log('File:', filename);
                console.log('Content hash:', contentHash);

                const { isDuplicate, documentId } = await checkDuplicateDocument(text);
                if (isDuplicate) {
                    console.log(`Found duplicate content (Document ID: ${documentId})`);
                    
                    // Save the document with skipped_duplicate status
                    await saveAnalysis(text, 'skipped_duplicate', {
                        filepath: filename,
                        duplicate_of: documentId,
                        warnings: [`Duplicate of document ${documentId}`],
                        content_hash: contentHash
                    });
                    
                    console.log(`Skipping ${filename} - recorded as duplicate of document ${documentId}`);
                    continue;
                }
                
                const txtPath = path.join(TEMP_DIR, `${path.parse(file).name}.txt`);
                await fs.writeFile(txtPath, text, 'utf8');
                
                // Step 2: Clean and chunk the text
                console.log('Cleaning and chunking...');
                const result = await processFile(
                    text, 
                    options.type, 
                    filename,
                    parseInt(options.maxChunkLength),
                    options.overview,
                    options.skipMetadata,
                    options.continuation,
                    contentHash,
                    previousText  // Pass the previous text
                );
                
                // Store text for next document if available
                previousText = result.textForNextDocument || '';
                
                // Step 3: Move original file to processed directory
                const processedPath = path.join(PROCESSED_DIR, file);
                await fs.rename(inputPath, processedPath);
                
                console.log(`Successfully processed ${file}`);
                console.log('Chunks:', result.chunks ? result.chunks.length : 0);
                if (result.warnings && result.warnings.length > 0) {
                    console.log('Warnings:', result.warnings);
                }

                // When saving analysis, use the skipMetadata option:
                await saveAnalysis(text, options.skipMetadata ? 'cleanAndChunk' : 'fullMetadata_only', {
                    filepath: filename,
                    warnings: result.warnings || []
                });
            } catch (error) {
                console.error(`Error processing ${file}:`, error.message);
                // Save failed status
                try {
                    await saveAnalysis(text || '', 'failed', {
                        filepath: filename,
                        warnings: [`Processing failed: ${error.message}`]
                    });
                } catch (saveError) {
                    console.error(`Error saving failed status: ${saveError.message}`);
                }
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
    .option('-r, --reprocessIncomplete', 'reprocess documents that are in processing status')
    .option('-s, --skipMetadata', 'skip the fullMetadata processing step')
    .action(async (options) => {
        options.maxChunkLength = options.maxChunkLength || 2000;
        await processDocuments(options);
    });

program.parse(); 