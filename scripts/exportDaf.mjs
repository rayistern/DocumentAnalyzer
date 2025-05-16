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
const { where, out = './daf.html' } = cliArgs();
if (!where) {
  console.error('usage: node exportDaf.mjs --where "document_id.eq.<uuid>" [--out ./file.html]');
  process.exit(1);
}
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 3. Fetch all rows for that document                                    │
async function fetchChunks(whereClause) {
  // PostgREST filter string → just tack it onto the /rest/v1 URL
  const url =
    `${process.env.SUPABASE_URL}/rest/v1/chunks?${whereClause}` +
    '&order=start_index' +
    '&select=id,start_index,cleaned_text,chunk_index,' +
             'chunk_metadata(long_summary,short_summary,quiz_questions,' +
                            'followup_thinking_questions,qa_pair)';

  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    }
  });

  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 4. Map DB rows → three HTML strings                                    │
function esc(str = '') {
  return str
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function list(items = []) {
  return items.length ? `<ul>${items.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>` : '';
}
function buildColumns(rows) {
  return rows.map(r => {
    const m = r.chunk_metadata?.[0];            // ← graceful when NULL
    return {
      gemara : esc(r.cleaned_text),
      left   : m
               ? `<strong>${esc(m.generated_title || '')}</strong>` +
                 list(m.quiz_questions) +
                 list(m.followup_thinking_questions) +
                 (m.qa_pair
                   ? `<details><summary>Q & A</summary><pre>${esc(m.qa_pair)}</pre></details>`
                   : '')
               : '<em>no metadata yet</em>',
      right  : m
               ? `${esc(m.long_summary || '')}<hr>${esc(m.short_summary || '')}`
               : ''
    };
  });
}
// ╰─────────────────────────────────────────────────────────────────────────╯


// ╭─────────────────────────────────────────────────────────────────────────╮
// │ 5. Wrap everything in a self-contained HTML page                       │
function buildHtml({ mainHTML, innerHTML, outerHTML }) {
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
        \`${mainHTML .replace(/`/g,'\\`')}\`,
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
  try {
    console.log('🔍  Fetching chunks …');
    const rows = await fetchChunks(where);

    if (!rows.length) {
      console.error('⚠️  No rows match your filter.');
      process.exit(0);
    }

    const html = buildHtml(buildColumns(rows));
    await writeFile(out, html, 'utf8');
    console.log(`🎉  Wrote ${path.resolve(out)}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();