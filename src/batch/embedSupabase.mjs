import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import settings from '../config/settings.mjs';
import supabase from '../services/supabaseClient.mjs';
import { embed } from '../services/embeddingProvider.mjs';
import logger from '../utils/logger.mjs';
import pLimit from 'p-limit';

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

  const limit = pLimit(5); // concurrency
  for (const spec of fieldSpecs) {
    logger.info(`→ ${spec.table}.${spec.column}`);
    let { data: rows, error } = await supabase
      .from(spec.table)
      .select(`id, ${spec.column}`)
      .match(spec.filter ? JSON.parse(spec.filter) : {});
    if (error) throw error;
    rows = rows.filter((r) => r[spec.column]);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  runEmbeddingJob().catch((e) => {
    logger.error(e);
    process.exit(1);
  });
} 