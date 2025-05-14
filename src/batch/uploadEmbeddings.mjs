import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import supabase from '../services/supabaseClient.mjs';
import logger from '../utils/logger.mjs';
import 'dotenv/config';

export async function uploadEmbeddings(args) {
  const {
    dir = './embeddings',
    batchSize = 20,
    pattern = '**/*.json',
    group,
    archive = true
  } = args;
  
  // Ensure batchSize is a number
  const page = Number(batchSize) > 0 ? Number(batchSize) : 20;
  
  logger.info(`🔍 Looking for embedding files in ${dir}...`);
  
  // Build glob pattern:   ./embeddings/<group>/**/*.json   or   ./embeddings/**/*.json
  const searchRoot  = group ? path.join(dir, group) : dir;

  // On Windows, glob likes forward slashes – replace "\" with "/"
  let globPattern   = path.join(searchRoot, pattern).replace(/\\/g, '/');

  logger.info(`📂 Glob pattern resolved to: ${globPattern}`);

  const jsonFiles = await glob(globPattern, { nodir: true });
  
  if (jsonFiles.length) {
    logger.info(
      `🔎 First ${Math.min(5, jsonFiles.length)} file(s):\n` +
      jsonFiles.slice(0, 5).join('\n')
    );
  }
  
  logger.info(`📊 Found ${jsonFiles.length} embedding files`);
  
  let uploadedTotal   = 0;
  let skippedByGroup  = 0;
  let readErrors      = 0;
  
  // Process in batches
  for (let i = 0; i < jsonFiles.length; i += page) {
    const slice = jsonFiles.slice(i, i + page);
    const embeddings  = [];
    let   accepted    = 0;
    let   skipped     = 0;
    
    logger.info(`⚙️ Processing batch ${i/page + 1}/${Math.ceil(jsonFiles.length/page)}`);
    
    const acceptedFilePaths = [];
    // Read each file in batch
    for (const filePath of slice) {
      try {
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));

        // ───── group filter ─────
        // 1. prefer the explicit JSON field
        // 2. fall back to the file-name pattern used by the old script
        const matchesGroup =
          !group ||
          data.group === group ||
          path.basename(filePath).includes(`_${group}_`);

        if (!matchesGroup) {
          skippedByGroup++;
          skipped++;
          continue;
        }

        embeddings.push({
          source_table: data.source_table,
          source_pk: data.source_pk,
          source_column: data.source_column,
          group: data.group || 'default',
          model: data.model,
          dim: data.dim,
          embedding: data.embedding
        });
        accepted++;
        acceptedFilePaths.push(filePath);
      } catch (err) {
        logger.error({ err, batch: i / page + 1 }, '❌ Upload error while upserting');
        readErrors++;
      }
    }
    
    logger.info(
      `🗂️  Batch ${i/page + 1}: files ${slice.length}, ` +
      `accepted ${accepted}, skipped ${skipped}, errors ${readErrors}`
    );
    
    // Upload batch to Supabase
    if (embeddings.length > 0) {
      try {
        const { error } = await supabase.from('embeddings').upsert(
          embeddings,
          { onConflict: 'source_table,source_pk,source_column,group,model' }
        );
        
        if (error) throw error;
        uploadedTotal += embeddings.length;
        logger.info(`✅ Uploaded ${embeddings.length} embeddings (total so far ${uploadedTotal})`);

        /* ───── archive uploaded files ───── */
        if (archive) {
          for (const srcPath of acceptedFilePaths) {
            const rel  = path.relative(dir, srcPath);                // keep group/… structure
            const dest = path.join(dir + '-uploaded', rel);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.rename(srcPath, dest);
          }
        }
      } catch (err) {
        logger.error(
          { err, batch: i / page + 1, embeddings, first: embeddings[0] },
          '❌ FULL Upload error object'
        );
      }
    } else {
      logger.warn('⚠️  No embeddings to upload in this batch');
      // Small delay between batches
      if (i + page < jsonFiles.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  
  logger.info(
    `✨ Upload complete! ` +
    `uploaded=${uploadedTotal}, skippedByGroup=${skippedByGroup}, readErrors=${readErrors}`
  );

  if (uploadedTotal === 0) {
    logger.warn(
      '⚠️  Nothing was uploaded. ' +
      (group
        ? `Make sure the files contain "group": "${group}" or the filename has "_${group}_".`
        : 'Check that your files contain valid embeddings.')
    );
  }
}

// For direct script execution
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await uploadEmbeddings({});
  } catch (error) {
    logger.error('Upload failed:', error);
    process.exit(1);
  }
} 