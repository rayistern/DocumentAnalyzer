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
    jsonbKey,
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
        
        
        // ------------------------------------------------------------------
        // 1)  Pull the raw column value
        // ------------------------------------------------------------------
        let textInput   = row[column];   // original value (could be string / JSON string / object / array / etc.)
        let usedJsonKey = null;          // will hold the key we actually embedded (or null)

        // ------------------------------------------------------------------
        // 2)  If the --jsonb-key flag was supplied, drill into that key
        // ------------------------------------------------------------------
        if (jsonbKey) {
          let parsedJson;

          // a) If the column arrived as a string, try to parse it as JSON
          if (typeof textInput === 'string') {
            try {
              parsedJson = JSON.parse(textInput);
              logger.info(`Row ${row.id}: parsed JSON from column "${column}".`);
            } catch (e) {
              logger.warn(
                `⚠️  Row ${row.id}: column "${column}" is a string but not valid JSON – cannot use --jsonb-key "${jsonbKey}". Skipping row.`
              );
              continue; // nothing to embed → skip
            }
          }
          // b) If it’s already an object (rare, but can happen)
          else if (typeof textInput === 'object' && textInput !== null) {
            parsedJson = textInput;
          }
          // c) Anything else (number, null, etc.) cannot contain the key
          else {
            logger.warn(
              `⚠️  Row ${row.id}: column "${column}" is neither JSON string nor object – cannot use --jsonb-key "${jsonbKey}". Skipping row.`
            );
            continue;
          }

          // We now have parsedJson → must be plain object (not array)
          if (
            parsedJson &&
            typeof parsedJson === 'object' &&
            !Array.isArray(parsedJson) &&
            Object.prototype.hasOwnProperty.call(parsedJson, jsonbKey)
          ) {
            textInput   = parsedJson[jsonbKey];
            usedJsonKey = jsonbKey;
            logger.info(
              `Row ${row.id}: extracted value from key "${jsonbKey}" (type: ${typeof textInput}).`
            );
          } else {
            logger.warn(
              `⚠️  Row ${row.id}: key "${jsonbKey}" not found in JSON parsed from column "${column}". Skipping row.`
            );
            continue;
          }
        }

        // ------------------------------------------------------------------
        // 3)  Convert textInput → string that we can embed
        // ------------------------------------------------------------------



        // Convert textInput to a string for embedding
        let textToEmbed;
        if (typeof textInput === 'string') {
          textToEmbed = textInput;
        } else if (Array.isArray(textInput)) {
          textToEmbed = textInput.map(item => String(item ?? '')).join(' '); 
        } else if (typeof textInput === 'object' && textInput !== null) {
          logger.warn(`⚠️ Row ${row.id}: Content for embedding from column "${column}" ${usedJsonKey ? `(key: "${usedJsonKey}")` : ''} is an object. Stringifying with JSON.stringify().`);
          textToEmbed = JSON.stringify(textInput);
        } else {
          textToEmbed = String(textInput ?? '');
        }

        textToEmbed = textToEmbed.trim();

        // Check for effectively empty text after processing (e.g. empty string, "{}", "[]")
        if (!textToEmbed || textToEmbed === '{}' || textToEmbed === '[]') {
          logger.warn(`⚠️ Row ${row.id} has effectively empty text in column "${column}" ${usedJsonKey ? `(key: "${usedJsonKey}")` : ''} after processing. Skipping.`);
          continue;
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
          source_jsonb_key: usedJsonKey,
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
            source_jsonb_key: usedJsonKey,
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