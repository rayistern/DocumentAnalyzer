import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import settings from '../config/settings.mjs';
import supabase from '../services/supabaseClient.mjs';
import { embed } from '../services/embeddingProvider.mjs';
import logger from '../utils/logger.mjs';
import 'dotenv/config';                       // ensure .env is loaded

export async function runEmbeddingJob() {
  const argv = yargs(hideBin(process.argv))
    .option('provider', { type: 'string' })
    .option('model', { type: 'string' })
    .option('batch', { type: 'number' })
    .option('table', { type: 'string' })
    .option('column', { type: 'string' })
    .option('filter', { type: 'string' })
    .parseSync();

  const provider = argv.provider || settings.embedding.provider;
  const model = argv.model || settings.embedding.model;
  const batchSize = argv.batch || settings.embedding.batchSize;
  const fieldSpecs =
    argv.table && argv.column
      ? [{ table: argv.table, column: argv.column, filter: argv.filter }]
      : settings.fields;

  if (!fieldSpecs.length) return logger.error('No fields specified');

  const limit = createLimiter(batchSize);   // new
  for (const spec of fieldSpecs) {
    logger.info(`→ ${spec.table}.${spec.column}`);
    // build query with optional JSON filter
    let query = supabase.from(spec.table).select(`id, ${spec.column}`);
    if (spec.filter) {
      const obj = safeParseFilter(spec.filter);
      if (obj) query = applyFilter(query, obj);
      else logger.warn(`⚠️ bad filter – ignored: ${spec.filter}`);
    }

    const { data: fetched, error } = await query;
    if (error) throw error;
    const rows = (fetched || []).filter(r => r[spec.column]);

    for (let i = 0; i < rows.length; i += batchSize) {
      const slice = rows.slice(i, i + batchSize);
      const embeddings = await Promise.all(
        slice.map((row) =>
          limit(async () => {
            try {
              const vector = await embed({ text: row[spec.column], provider, model });
              return { row, vector };
            } catch (e) {
              logger.error(e);
              return null;
            }
          }),
        ),
      );

      const upserts = embeddings
        .filter(Boolean)
        .map(({ row, vector }) => ({
          source_table: spec.table,
          source_pk: row.id,
          source_column: spec.column,
          model,
          dim: vector.length,
          embedding: vector,
        }));

      if (upserts.length) {
        const { error: upErr } = await supabase.from('embeddings').upsert(upserts, {
          onConflict: 'source_table,source_pk,source_column,model',
        });
        if (upErr) throw upErr;
        logger.info(`   upserted ${upserts.length}`);
      }
      if (settings.embedding.rateLimitMs)
        await new Promise((r) => setTimeout(r, settings.embedding.rateLimitMs));
    }
  }
  logger.info('✅ done');
}

// handle PowerShell escape mess directly
function safeParseFilter(str) {
  try { return JSON.parse(str); } catch {}
  try { return JSON.parse(str.replace(/\\"/g, '"')); } catch {}
  
  // Direct pattern matching for common PowerShell escaped patterns
  const ltMatch = str.match(/\\?"id\\?":\\?"lt\.(\d+)\\?"/);
  if (ltMatch) return { id: `lt.${ltMatch[1]}` };
  
  const gtMatch = str.match(/\\?"id\\?":\\?"gt\.(\d+)\\?"/);
  if (gtMatch) return { id: `gt.${gtMatch[1]}` };
  
  return null;
}

// translate {"id":"lt.11"} ⇢ query.lt('id',11)
function applyFilter(q, obj) {
  for (const [col, val] of Object.entries(obj)) {
    if (typeof val === 'string' && val.startsWith('lt.')) {
      q = q.lt(col, val.slice(3));
    } else if (typeof val === 'string' && val.startsWith('gt.')) {
      q = q.gt(col, val.slice(3));
    } else {
      q = q.eq(col, val);
    }
  }
  return q;
}

// very-small replacement for `p-limit`
function createLimiter(concurrency = 5) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    const { fn, res, rej } = queue.shift();
    active++;
    Promise.resolve(fn())
      .then(res, rej)
      .finally(() => {
        active--;
        next();
      });
  };
  return fn => new Promise((res, rej) => {
    queue.push({ fn, res, rej });
    next();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEmbeddingJob().catch((e) => {
    logger.error('Embedding failed:', e);
    process.exit(1);
  });
} 