#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { processFile } from './services/openaiService.mjs';
import { saveResult, getResults, getRecentValidationLogs, getRecentApiLogs } from './services/storageService.mjs';
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
            const result = await processFile(content, options.type, parseInt(options.maxChunkLength));

            if (result.error) {
                console.error('Processing failed:');
                console.error(result.error);
                process.exit(1);
            }

            console.log('Storing result...');
            await saveResult({
                filepath,
                type: options.type,
                content: result
            });

            console.log('Result:', JSON.stringify(result, null, 2));
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
            for (const doc of Object.values(results)) {
                console.log(`\nDocument: ${doc.filepath}`);
                console.log(`Total Length: ${doc.totalLength}`);
                console.log(`Created: ${doc.createdAt}`);
                console.log('Chunks:', doc.chunks.length);
                doc.chunks.forEach((chunk, i) => {
                    console.log(`  ${i + 1}. ${chunk.firstWord}...${chunk.lastWord} (${chunk.endIndex - chunk.startIndex} chars)`);
                });
            }
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program
    .command('validation-logs')
    .description('Show recent chunk validation failures')
    .action(async () => {
        try {
            const logs = await getRecentValidationLogs();
            const apiLogs = await getRecentApiLogs();

            console.log('\nRecent Chunk Validation Results:');
            logs.forEach((log, i) => {
                console.log('\n' + '='.repeat(80));
                console.log(`CHUNK #${log.chunkIndex}:`);
                console.log('='.repeat(80));

                console.log('\nINDEXES FROM AI:');
                console.log(`Start: ${log.indexes.start}`);
                console.log(`End: ${log.indexes.end}`);
                console.log(`Length: ${log.indexes.end - log.indexes.start} characters`);

                console.log('\nEXPECTED BOUNDARIES (from AI):');
                console.log(`First word: "${log.expected.firstWord}"`);
                console.log(`Last word: "${log.expected.lastWord}"`);

                console.log('\nACTUAL TEXT FOUND:');
                console.log(`First word: "${log.actual.firstWord}"`);
                console.log(`Last word: "${log.actual.lastWord}"`);

                console.log('\nFULL CHUNK TEXT:');
                // Add quotes and show exact characters
                console.log('"""\n' + log.chunkText + '\n"""');

                if (log.followingContext) {
                    console.log('\nNEXT CHARACTERS (showing exact breaks):');
                    // Show exact characters including newlines etc
                    const contextDisplay = log.followingContext
                        .replace(/\n/g, '\\n')
                        .replace(/\r/g, '\\r')
                        .replace(/\t/g, '\\t');
                    console.log(`"${contextDisplay}"`);
                }

                if (!log.passed) {
                    console.log('\nVALIDATION ERROR:');
                    console.log(log.error);
                }

                // Find and display the full AI response
                const apiLog = apiLogs.find(al => 
                    al.requestType === 'chunk' && 
                    al.responsePayload?.parsed?.chunks?.some(c => 
                        c.startIndex === log.indexes.start && 
                        c.endIndex === log.indexes.end
                    )
                );

                console.log('\nFULL AI INTERACTION:');
                if (apiLog) {
                    console.log('\nREQUEST:');
                    console.log(JSON.stringify(apiLog.requestPayload, null, 2));
                    console.log('\nRESPONSE:');
                    console.log(JSON.stringify(apiLog.responsePayload, null, 2));
                } else {
                    console.log('(No matching API log found)');
                }

                console.log('\n' + '='.repeat(80));
            });
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program
    .command('api-logs')
    .description('Show recent API calls and their results')
    .action(async () => {
        try {
            const logs = await getRecentApiLogs();
            console.log('\nRecent API Calls:');
            logs.forEach((log, i) => {
                console.log(`\nCall #${i + 1}:`);
                console.log(`Type: ${log.requestType}`);
                console.log(`Success: ${log.success}`);
                if (!log.success) {
                    console.log('Error:', log.error);
                }
                console.log('Request:', log.requestPayload);
                console.log('Response:', log.responsePayload);
            });
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    });

program.parse();