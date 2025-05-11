import settings from '../config/settings.mjs';
import supabase from '../services/supabaseClient.mjs';
import { embed } from '../services/embeddingProvider.mjs';
import logger from '../utils/logger.mjs';
import 'dotenv/config';

// much simpler embed with direct flags
export async function basicEmbed(args) {
  const { 
    table, column, 
    id, lt, gt,
    group = 'default',
    batch = 5, provider, model 
  } = args;
  
  if (!table || !column) {
    throw new Error('Table and column are required');
  }

  logger.info(`⏩ Starting embedding for ${table}.${column}`);
  
  // Build query with simpler filters
  let query = supabase.from(table).select(`id, ${column}`);
  
  if (id) query = query.eq('id', id);
  if (lt) query = query.lt('id', lt);
  if (gt) query = query.gt('id', gt);
  
  logger.info(`🔍 Filter: ${id ? 'id='+id : ''} ${lt ? 'id<'+lt : ''} ${gt ? 'id>'+gt : ''}`);
  
  const { data: rows, error } = await query;
  if (error) throw error;
  
  const filtered = (rows || []).filter(r => r[column]);
  logger.info(`📊 Found ${filtered.length} rows with content`);
  
  for (let i = 0; i < filtered.length; i++) {
    const row = filtered[i];
    try {
      logger.info(`⚙️ Processing row ${i+1}/${filtered.length} (id: ${row.id})`);
      
      // Check if embedding already exists in Supabase
      const embeddingModel = model || settings.embedding?.model;
      const { data: existingEmbedding, error: checkError } = await supabase
        .from('embeddings')
        .select('id')
        .eq('source_table', table)
        .eq('source_pk', row.id)
        .eq('source_column', column)
        .eq('group', group)
        .eq('model', embeddingModel)
        .maybeSingle();
      
      if (checkError) {
        logger.warn(`⚠️ Error checking existing embedding for row ${row.id}:`, checkError.message);
      } else if (existingEmbedding) {
        logger.info(`⏩ Skipping row ${row.id} - embedding already exists for group "${group}"`);
        continue; // Skip to next row
      }
      
      const vector = await embed({ 
        text: row[column],
        provider: provider || settings.embedding?.provider,
        model: model || settings.embedding?.model,
      });
      
      const result = await supabase.from('embeddings').upsert({
        source_table: table,
        source_pk: row.id,
        source_column: column,
        group: group,
        model: model || settings.embedding?.model,
        dim: vector.length,
        embedding: vector,
      }, { onConflict: 'source_table,source_pk,source_column,model' });
      
      if (result.error) throw result.error;
      logger.info(`✅ Embedded and saved row ${row.id}`);
    } catch (e) {
      logger.error(`❌ Error with row ${row.id}:`, JSON.stringify({
        message: e.message || 'Unknown error',
        name: e.name,
        stack: e.stack?.split('\n')[0],
        response: e.response?.data || e.response
      }));
      
      // Add fallback model if model not found/supported
      if (e.message && (e.message.includes('model') || e.message.includes('not found'))) {
        try {
          logger.info(`⚠️ Trying fallback embedding model...`);
          const fallbackModel = 'text-embedding-ada-002'; // OpenAI reliable fallback
          
          const vector = await embed({ 
            text: row[column],
            provider: 'openai',
            model: fallbackModel,
          });
          
          const result = await supabase.from('embeddings').upsert({
            source_table: table,
            source_pk: row.id,
            source_column: column,
            group: group,
            model: fallbackModel,
            dim: vector.length,
            embedding: vector,
          }, { onConflict: 'source_table,source_pk,source_column,model' });
          
          if (result.error) throw result.error;
          logger.info(`✅ Embedded and saved row ${row.id} with fallback model`);
        } catch (fallbackError) {
          logger.error(`❌ Fallback also failed for row ${row.id}:`, JSON.stringify({
            message: fallbackError.message || 'Unknown error',
            name: fallbackError.name,
            stack: fallbackError.stack?.split('\n')[0],
            response: fallbackError.response?.data || fallbackError.response
          }));
        }
      }
    }
  }
  
  logger.info('✨ All done!');
}

// For direct script execution 
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    // Default params for direct execution
    const params = {
      table: 'chunk_metadata',
      column: 'long_summary',
      lt: 11,
      group: 'default',
      model: 'text-embedding-ada-002',
      provider: 'openai'
    };
    
    logger.info('Running standalone with params:', params);
    await basicEmbed(params);
  } catch (error) {
    logger.error('Failed in direct execution:', error);
    process.exit(1);
  }
} 