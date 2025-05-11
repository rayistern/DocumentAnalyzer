import fs from 'fs/promises';
import path from 'path';
import supabase from '../services/supabaseClient.mjs';
import logger from '../utils/logger.mjs';
import 'dotenv/config';

export async function uploadEmbeddings(args) {
  const { 
    dir = './embeddings',
    batchSize = 20,
    pattern = '*.json'
  } = args;
  
  logger.info(`🔍 Looking for embedding files in ${dir}...`);
  
  // Get all JSON files in directory
  const files = await fs.readdir(dir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  
  logger.info(`📊 Found ${jsonFiles.length} embedding files`);
  
  // Process in batches
  for (let i = 0; i < jsonFiles.length; i += batchSize) {
    const batch = jsonFiles.slice(i, i + batchSize);
    const embeddings = [];
    
    logger.info(`⚙️ Processing batch ${i/batchSize + 1}/${Math.ceil(jsonFiles.length/batchSize)}`);
    
    // Read each file in batch
    for (const file of batch) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
        embeddings.push({
          source_table: data.source_table,
          source_pk: data.source_pk,
          source_column: data.source_column,
          model: data.model,
          dim: data.dim,
          embedding: data.embedding
        });
      } catch (err) {
        logger.error(`❌ Error reading ${file}:`, err.message);
      }
    }
    
    // Upload batch to Supabase
    if (embeddings.length > 0) {
      try {
        const { error } = await supabase.from('embeddings').upsert(
          embeddings,
          { onConflict: 'source_table,source_pk,source_column,model' }
        );
        
        if (error) throw error;
        logger.info(`✅ Uploaded ${embeddings.length} embeddings to Supabase`);
      } catch (err) {
        logger.error('❌ Upload error:', err.message);
      }
    }
    
    // Small delay between batches
    if (i + batchSize < jsonFiles.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  logger.info('✨ Upload complete!');
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