#!/usr/bin/env node
/**
 * Usage:
 *   node src/debug/testSnippetMatching.mjs path/to/text.txt "startSnippet" "endSnippet"
 */
import fs from 'fs/promises';
import { extractChunkBySnippets } from '../utils/chunkingUtils.mjs';

async function main() {
  const [file, startSnippet, endSnippet] = process.argv.slice(2);
  if (!file || !startSnippet || !endSnippet) {
    console.error('Usage: testSnippetMatching <file> <startSnippet> <endSnippet>');
    process.exit(1);
  }

  const text   = await fs.readFile(file, 'utf8');
  const chunk  = extractChunkBySnippets({ text, startSnippet, endSnippet });

  if (chunk) {
    console.log('--- extracted chunk ---');
    console.log(chunk);
    console.log('-----------------------');
  } else {
    console.error('Failed to extract chunk – see log for details.');
    process.exit(2);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(99);
}); 