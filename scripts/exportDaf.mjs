#!/usr/bin/env node
/*  Export one (or many) daf-pages from Supabase as stand-alone HTML
 *
 *  Usage:
 *      node scripts/exportDaf.mjs \
 *          --where "document_id.eq.<UUID>" \
 *          --out   "./out/page.html"
 *
 *  Dependencies (already in your package.json):
 *      @supabase/supabase-js
 *      daf-renderer
 */

import 'dotenv/config';                       // ← loads .env automatically
import { createClient } from '@supabase/supabase-js';
import { writeFile }    from 'node:fs/promises';
import path             from 'node:path';
import process          from 'node:process';

// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 1. Supabase client (taken from your .env)                              │
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY
);
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 2. Small CLI helper                                                    │
function cliArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    out[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  }
  return out;
}
const { where, out = './daf.html', limit } = cliArgs();
if (!where) {
  console.error('usage: node exportDaf.mjs --where "document_id.eq.<uuid>" [--limit 200] [--out ./file.html]');
  process.exit(1);
}
const hardLimit = Number(limit) || null;                  // null = no limit


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ List available documents based on chunks table                          │
async function listAvailableDocuments() {
  console.log('📋 Listing available documents from chunks table:');
  
  try {
    // Get distinct document_ids from chunks table instead
    const { data: documents, error } = await supabase
      .from('chunks')
      .select('document_id, cleaned_text')
      .order('created_at', { ascending: false })
      .limit(50); // Get a sample of chunks
    
    if (error) {
      console.error(`Could not fetch chunks list:`, error.message);
      return;
    }
    
    if (!documents || documents.length === 0) {
      console.log('No chunks found in database.');
      return;
    }
    
    // Extract unique document IDs and a sample of text for each
    const docMap = new Map();
    documents.forEach(chunk => {
      if (!docMap.has(chunk.document_id)) {
        // Use first few words of the first chunk as a title substitute
        const titlePreview = chunk.cleaned_text?.substring(0, 50).replace(/\n/g, ' ') || 'Unknown content';
        docMap.set(chunk.document_id, titlePreview);
      }
    });
    
    console.log(`Found ${docMap.size} unique documents with chunks:`);
    docMap.forEach((preview, docId) => {
      const safeName = docId.substring(0, 8);
      console.log(`- Preview: "${preview}..." (ID: ${docId})`);
      console.log(`  Export command: node scripts/exportDaf.mjs --where "document_id.eq.${docId}" --out "./out/${safeName}.html"\n`);
    });
  } catch (error) {
    console.error('Error listing documents:', error.message);
  }
}

// ╭─────────────────────────────────────────────────────────────────────────╮
// │ Fetch chunks directly without checking documents                         │
async function fetchChunks(whereClause, pageSize = 100) {
  // Extract document_id from the where clause
  const docIdMatch = whereClause.match(/document_id\.eq\.([0-9a-f-]+)/i);
  const docId = docIdMatch ? docIdMatch[1] : 'unknown';
  console.log(`🔍 Fetching chunks for document ID: ${docId}`);
  
  try {
    // Skip document checking - go straight to chunks
    let allChunks = [];
    let offset = 0;
    
    while (true) {
      const limit = hardLimit ? Math.min(pageSize, hardLimit - offset) : pageSize;
      if (limit <= 0) break;
      
      console.log(`📄 Fetching page ${Math.floor(offset/pageSize) + 1}, offset: ${offset}, limit: ${limit}`);
      
      const { data: chunks, error: chunksError } = await supabase
        .from('chunks')
        .select('id, start_index, cleaned_text, chunk_index, chunk_metadata(long_summary, short_summary, generated_title, quiz_questions, followup_thinking_questions, qa_pair)')
        .eq('document_id', docId)
        .order('start_index', { ascending: true })
        .range(offset, offset + limit - 1);
      
      if (chunksError) {
        console.error(`Error fetching chunks:`, chunksError.message);
        throw new Error(`Failed to fetch chunks: ${chunksError.message}`);
      }
      
      if (!chunks || chunks.length === 0) {
        if (offset === 0) {
          console.warn(`⚠️ No chunks found for document ID: ${docId}`);
          await listAvailableDocuments();
        } else {
          console.log(`No more chunks found.`);
        }
        break;
      }
      
      console.log(`✓ Got ${chunks.length} chunks`);
      allChunks.push(...chunks);
      
      offset += pageSize;
      
      if (chunks.length < limit || (hardLimit && allChunks.length >= hardLimit)) {
        break;
      }
    }
    
    console.log(`✅ Total chunks fetched: ${allChunks.length}`);
    return allChunks;
    
  } catch (error) {
    console.error(`Error in fetchChunks:`, error.message);
    throw error;
  }
}
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 4. Convert DB rows to HTML columns                                      │
function esc(value) {
  return String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function list(items) {
  // Guard against null/undefined and ensure we have an array
  if (!items) return '';
  
  // If it's already an array, use it; otherwise convert to array
  const arr = Array.isArray(items) ? items : [items];
  
  // Only build an unordered list if there are items
  return arr.length ? `<ul>${arr.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>` : '';
}

function buildColumns(rows) {
  const main  = [];
  const inner = [];
  const outer = [];

  for (const r of rows) {
    const m = r.chunk_metadata?.[0];            // ← graceful when NULL
    main.push(esc(r.cleaned_text));
    inner.push(m
      ? `<strong>${esc(m.generated_title || '')}</strong>` +
        list(m.quiz_questions) +
        list(m.followup_thinking_questions) +
        (m.qa_pair
          ? `<details><summary>Q & A</summary><pre>${esc(m.qa_pair)}</pre></details>`
          : '')
      : '<em>no metadata yet</em>');
    outer.push(m
      ? `${esc(m.long_summary || '')}<hr>${esc(m.short_summary || '')}`
      : '');
  }

  return {
    mainHTML  : main.join(''),
    innerHTML : inner.join(''),
    outerHTML : outer.join('')
  };
}
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 5. Wrap everything in a self-contained HTML page                       │
function buildHtml({ mainHTML = '', innerHTML = '', outerHTML = '' } = {}) {
  const DAF_JS = 'https://unpkg.com/daf-renderer@latest/dist/daf-renderer.min.js';

  return `<!DOCTYPE html>
<html lang="he">
<head>
  <meta charset="utf-8">
  <title>Daf</title>
  <style>body{margin:0;padding:0;font-family:"Times New Roman",serif;}</style>
  <script src="${DAF_JS}"></script>
</head>
<body>
  <div id="daf" style="margin:2rem;"></div>

  <script>
    (function init() {
      if (!window.dafRenderer) return setTimeout(init, 20);

      const renderer = window.dafRenderer("#daf", {
        contentWidth: "900px",
        fontFamily: { main: "Times New Roman", inner: "Times New Roman", outer: "Times New Roman" }
      });

      renderer.render(
        \`${mainHTML.replace(/`/g,'\\`')}\`,
        \`${innerHTML.replace(/`/g,'\\`')}\`,
        \`${outerHTML.replace(/`/g,'\\`')}\`,
        "b"
      );
    })();
  </script>
</body>
</html>`;
}
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 6. Glue it all together                                               │
(async () => {
  console.log('🔍  Fetching chunks …');
  
  try {
    const rows = await fetchChunks(where);

    if (rows.length === 0) {
      console.error('No chunks found for that document.');
      process.exit(1);
    }

    const columns = buildColumns(rows);   // <- returns {mainHTML, …}
    const html    = buildHtml(columns);   // <- pass the whole object
    await writeFile(out, html, 'utf8');
    console.log(`🎉  Wrote ${path.resolve(out)}`);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
})();