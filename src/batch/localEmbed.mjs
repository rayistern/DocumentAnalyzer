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
    batch = 5, provider, model 
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
  
  const { data: rows, error } = await query;
  if (error) throw error;
  
  const filtered = (rows || []).filter(r => r[column]);
  logger.info(`📊 Found ${filtered.length} rows with content`);
  
  for (let i = 0; i < filtered.length; i++) {
    const row = filtered[i];
    const embeddingModel = model || settings.embedding?.model || 'text-embedding-ada-002';
    const embeddingProvider = provider || settings.embedding?.provider || 'openai';
    
    try {
      logger.info(`⚙️ Processing row ${i+1}/${filtered.length} (id: ${row.id})`);
      
      const vector = await embed({ 
        text: row[column],
        provider: embeddingProvider,
        model: embeddingModel,
      });
      
      // Save to local file
      const embeddingData = {
        source_table: table,
        source_pk: row.id,
        source_column: column,
        model: embeddingModel,
        provider: embeddingProvider,
        dim: vector.length,
        embedding: vector,
        created_at: new Date().toISOString()
      };
      
      const filename = `${table}_${row.id}_${column}_${embeddingModel.replace(/[^a-z0-9]/gi, '_')}.json`;
      await fs.writeFile(
        path.join(outputDir, filename), 
        JSON.stringify(embeddingData, null, 2)
      );
      
      logger.info(`✅ Embedded and saved row ${row.id} to ${filename}`);
    } catch (e) {
      logger.error(`❌ Error with row ${row.id}:`, JSON.stringify({
        message: e.message || 'Unknown error',
        name: e.name,
        stack: e.stack?.split('\n')[0],
        response: e.response?.data || e.response
      }));
      
      // Try fallback model
      try {
        logger.info(`⚠️ Trying fallback embedding model...`);
        const fallbackModel = 'text-embedding-ada-002';
        
        const vector = await embed({ 
          text: row[column],
          provider: 'openai',
          model: fallbackModel,
        });
        
        // Save to local file
        const embeddingData = {
          source_table: table,
          source_pk: row.id,
          source_column: column,
          model: fallbackModel,
          provider: 'openai',
          dim: vector.length,
          embedding: vector,
          created_at: new Date().toISOString()
        };
        
        const filename = `${table}_${row.id}_${column}_${fallbackModel.replace(/[^a-z0-9]/gi, '_')}.json`;
        await fs.writeFile(
          path.join(outputDir, filename), 
          JSON.stringify(embeddingData, null, 2)
        );
        
        logger.info(`✅ Embedded and saved row ${row.id} to ${filename} with fallback model`);
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