#!/usr/bin/env node

import { Command } from 'commander';
import { batchConvert } from './utils/documentConverter.mjs';

const program = new Command();

program
    .name('document-converter')
    .description('Convert documents to text files')
    .version('1.0.0');

program
    .argument('<pattern>', 'glob pattern for files to convert (e.g. "*.docx" or "docs/*.doc")')
    .option('-o, --output <dir>', 'output directory for converted files', 'converted')
    .action(async (pattern, options) => {
        try {
            const results = await batchConvert(pattern, options.output);
            if (results) {
                const successful = results.filter(r => r.success).length;
                const failed = results.filter(r => !r.success).length;
                console.log(`\nConversion complete: ${successful} succeeded, ${failed} failed`);
            }
        } catch (error) {
            console.error('Conversion error:', error.message);
            process.exit(1);
        }
    });

program.parse(); 