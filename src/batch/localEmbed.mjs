import fs from 'fs/promises';
import path from 'path';
import settings from '../config/settings.mjs';
import supabase from '../services/supabaseClient.mjs';
import { embed } from '../services/embeddingProvider.mjs';
import logger from '../utils/logger.mjs';
import 'dotenv/config';

// Embed content and save to local files
export async function localEmbed(args) {
  const { 
    table, column, 
    id, lt, gt,
    outputDir = './embeddings',
    group = 'default',
    batch = 5, provider, model,
    options
  } = args;
  
  if (!table || !column) {
    throw new Error('Table and column are required');
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });
  
  logger.info(`⏩ Starting local embedding for ${table}.${column}`);
  
  // Build query with simpler filters
  let query = supabase.from(table).select(`id, ${column}`);
  
  if (id) query = query.eq('id', id);
  if (lt) query = query.lt('id', lt);
  if (gt) query = query.gt('id', gt);
  
  logger.info(`🔍 Filter: ${id ? 'id='+id : ''} ${lt ? 'id<'+lt : ''} ${gt ? 'id>'+gt : ''}`);
  
  // ------------- NEW: paginate because Supabase caps each response at 1000
  const pageSize   = Math.min(batch > 0 ? batch : 1000, 1000);   // Supabase hard-limit
  let   from       = 0;
  let   page       = 0;
  let   globalIdx  = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data: pageRows, error } =
      await query.range(from, to);          // <-- pagination magic

    if (error) throw error;
    if (!pageRows?.length) break;           // done

    const filtered = pageRows.filter(r => r[column]);
    logger.info(`📊 Page ${++page}: got ${filtered.length}/${pageRows.length} usable rows (range ${from}-${to})`);

    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      const embeddingModel = model || settings.embedding?.model || 'text-embedding-ada-002';
      const embeddingProvider = provider || settings.embedding?.provider || 'openai';
      
      // Set strictMode for this row based on CLI flag
      const strictMode = options?.strict ?? options?.strictMode ?? false;
      
      try {
        logger.info(`⚙️ Processing row ${++globalIdx} (id: ${row.id})`);
        
        // Ensure text is a non-empty string
        let textToEmbed = row[column];
        if (Array.isArray(textToEmbed)) {
          textToEmbed = textToEmbed.join(' ');
        }
        if (typeof textToEmbed !== 'string') {
          textToEmbed = String(textToEmbed ?? '');
        }
        textToEmbed = textToEmbed.trim();
        if (!textToEmbed) {
          logger.warn(`⚠️ Row ${row.id} has empty or missing text in column "${column}". Skipping.`);
          continue; // skip this row
        }
        
        // For local provider, get both embedding and actual model used
        let vector;
        let actualModel = embeddingModel;
        
        if (embeddingProvider === 'local') {
          const result = await embed({ 
            text: textToEmbed,
            provider: embeddingProvider,
            model: embeddingModel,
            options: {
              ...(options || {}),
              strictMode,
              task: options?.task
            }
          });
          // Extract embedding and actual model
          vector = result.embedding;
          actualModel = result.actualModel || embeddingModel;
        } else {
          // Normal embedding for non-local providers
          vector = await embed({ 
            text: textToEmbed,
            provider: embeddingProvider,
            model: embeddingModel,
          });
        }
        
        // Use actual model in filename
        const groupDir = path.join(outputDir, group);
        await fs.mkdir(groupDir, { recursive: true });
        
        const outFile = path.join(
          groupDir,
          `${table}_${row.id}_${column}_${group}_${actualModel.replace(/[^a-z0-9]/gi, '_')}.json`
        );
        
        // Check if embedding already exists
        try {
          await fs.access(outFile);
          logger.info(`⏩ Skipping row ${row.id} - embedding already exists for group "${group}"`);
          continue; // Skip to next row
        } catch (err) {
          // File doesn't exist, continue processing
        }
        
        // Save to local file
        const embeddingData = {
          source_table: table,
          source_pk: row.id,
          source_column: column,
          group,
          model: actualModel,
          provider: embeddingProvider,
          dim: vector.length,
          embedding: vector,
          created_at: new Date().toISOString()
        };
        
        await fs.writeFile(outFile, JSON.stringify(embeddingData, null, 2));
        
        logger.info(`✅ Embedded and saved row ${row.id} to ${outFile}`);
      } catch (err) {
        logger.error(`❌ Error with row ${row.id}:`, err);

        // Only fallback if strictMode is not set
        if (strictMode) {
          logger.error(`❌ Skipping fallback for row ${row.id} due to strictMode.`);
          throw err; // Stop the process entirely. Use 'continue;' to skip just this row.
        }

        logger.info('⚠️ Trying fallback embedding model...');
        try {
          const fallbackModel = 'text-embedding-ada-002';
          
          const vector = await embed({ 
            text: textToEmbed,
            provider: 'openai',
            model: fallbackModel,
          });
          
          // Save to local file
          const embeddingData = {
            source_table: table,
            source_pk: row.id,
            source_column: column,
            group: group,
            model: fallbackModel,
            provider: 'openai',
            dim: vector.length,
            embedding: vector,
            created_at: new Date().toISOString()
          };
          
          const fallbackOutFile = path.join(
            groupDir,
            `${table}_${row.id}_${column}_${group}_${fallbackModel.replace(/[^a-z0-9]/gi, '_')}.json`
          );
          
          // Check if embedding already exists
          try {
            await fs.access(fallbackOutFile);
            logger.info(`⏩ Skipping row ${row.id} - embedding already exists for group "${group}"`);
            continue; // Skip to next row
          } catch (err) {
            // File doesn't exist, continue processing
          }
          
          await fs.writeFile(fallbackOutFile, JSON.stringify(embeddingData, null, 2));
          
          logger.info(`✅ Embedded and saved row ${row.id} to ${fallbackOutFile} with fallback model`);
        } catch (fallbackError) {
          logger.error({ err, row },`❌ Fallback also failed for row ${row.id}:`, JSON.stringify({
            message: fallbackError.message || 'Unknown error',
            name: fallbackError.name,
            stack: fallbackError.stack?.split('\n')[0],
            response: fallbackError.response?.data || fallbackError.response
          }));
        }
      }
    }

    from += pageSize;                       // next page
  }     // end while-pagination loop

  logger.info('✨ All done! Embeddings saved to ' + outputDir);
}

// For direct script execution 
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    // Default params for direct execution
    const params = {
      table: 'chunk_metadata',
      column: 'long_summary',
      lt: 11,
      outputDir: './embeddings',
      group: 'default',
      model: 'text-embedding-ada-002',
      provider: 'openai'
    };
    
    logger.info('Running standalone with params:', params);
    await localEmbed(params);
  } catch (error) {
    logger.error('Failed in direct execution:', error);
    process.exit(1);
  }
}

async function processFilesInDirectory(directory) {
    const files = await fs.readdir(directory);
    // If you want to ensure numeric order with padding:
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    for (const file of files) {
        // ... process each file ...
    }
} 