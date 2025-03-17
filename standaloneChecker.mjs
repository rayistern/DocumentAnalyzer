import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

// Handle relative paths properly
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables - look for .env in parent directories too
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Create OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configuration
const MAX_RECORDS = 100; // Max records to process in one run
const TEMPERATURE = 0.2;  // Temperature for OpenAI API (0.0 = most deterministic, 1.0 = most creative)
const MODEL = "gpt-4o-mini"; // Model to use for evaluation

// Sleep function to add delay between operations
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main function
async function checkStandaloneAnswers() {
  console.log('Starting standalone answer check process...');
  console.log(`SUPABASE_URL: ${process.env.SUPABASE_URL ? 'Set' : 'Not set'}`);
  console.log(`SUPABASE_ANON_KEY: ${process.env.SUPABASE_ANON_KEY ? 'Set' : 'Not set'}`);
  console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'Set' : 'Not set'}`);
  console.log(`Using model: ${MODEL}, temperature: ${TEMPERATURE}`);
  
  try {
    // Get a limited batch of document IDs only (much lighter query)
    console.log(`Fetching a batch of up to ${MAX_RECORDS} document IDs...`);
    const { data: docIds, error: idError } = await supabase
      .from('documents')
      .select('id')
      .is('standalone', null)
      .not('questions_answered', 'is', null)
      .order('created_at', { ascending: false })
      .limit(MAX_RECORDS);
    
    if (idError) {
      throw idError;
    }
    
    if (!docIds || docIds.length === 0) {
      console.log('No documents found that need processing.');
      return;
    }
    
    console.log(`Found ${docIds.length} documents to process.`);
    
    // Process each document by ID
    let processedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const docIdObj of docIds) {
      processedCount++;
      
      // Get full document data, one at a time
      const { data: docs, error: docError } = await supabase
        .from('documents')
        .select('id, questions_answered, api_metadata')
        .eq('id', docIdObj.id)
        .single();
      
      if (docError) {
        console.error(`Error fetching document ${docIdObj.id}:`, docError);
        continue;
      }
      
      const doc = docs;
      
      console.log(`\nProcessing document ${processedCount}/${docIds.length} (ID: ${doc.id})`);
      
      // Check if document has the right model in api_metadata
      if (doc.api_metadata) {
        const metadataStr = typeof doc.api_metadata === 'object' 
          ? JSON.stringify(doc.api_metadata) 
          : doc.api_metadata;
        
        if (!metadataStr.includes('gpt-4.5-preview-2025')) {
          console.log(`Skipping document ${doc.id} - not using required model`);
          skippedCount++;
          continue;
        }
      } else {
        console.log(`Skipping document ${doc.id} - no api_metadata`);
        skippedCount++;
        continue;
      }
      
      // Get questions_answered content
      const questionsAnswered = Array.isArray(doc.questions_answered) 
        ? doc.questions_answered.join('\n\n') 
        : doc.questions_answered;
      
      if (!questionsAnswered || questionsAnswered.length === 0) {
        console.log(`Skipping document ${doc.id} - empty questions_answered`);
        skippedCount++;
        continue;
      }
      
      // Prepare prompt
      const prompt = `${questionsAnswered}
      This is a QA pair to be used in training a model. It was generated using RAG, and we want to explore if it can be standalone without that context.
      Could the answer above have been formulated fully, clearly, and reliably without referencing additional context, specifics, or clarification from an external source?

Respond with either:
- "TRUE" if it's fully standalone.
- "FALSE" if it may lean on context or references not provided in the answer.`;
      
      // Call OpenAI API
      try {
        console.log(`Sending request to OpenAI for document ${doc.id}...`);
        const response = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "user", content: prompt }
          ],
          temperature: TEMPERATURE,
          max_tokens: 10 // Limiting tokens to enforce short response
        });
        
        const result = response.choices[0].message.content.trim();
        console.log(`OpenAI response for document ${doc.id}: "${result}"`);
        
        // Process the result
        let standaloneValue = null;
        if (result.toUpperCase() === 'TRUE') {
          standaloneValue = true;
        } else if (result.toUpperCase() === 'FALSE') {
          standaloneValue = false;
        } else {
          console.log(`Warning: Unexpected response for document ${doc.id}: "${result}"`);
          skippedCount++;
          continue; // Skip updating this document
        }
        
        // Update the document
        if (standaloneValue !== null) {
          const { error: updateError } = await supabase
            .from('documents')
            .update({ standalone: standaloneValue })
            .eq('id', doc.id);
          
          if (updateError) {
            console.error(`Error updating document ${doc.id}:`, updateError);
            skippedCount++;
          } else {
            console.log(`Successfully updated document ${doc.id} with standalone = ${standaloneValue}`);
            updatedCount++;
          }
        }
        
        // Add a short delay between API calls to avoid rate limits
        await sleep(500);
        
      } catch (apiError) {
        console.error(`OpenAI API error for document ${doc.id}:`, apiError.message);
        skippedCount++;
      }
    }
    
    console.log(`\nProcess completed:`);
    console.log(`- Total documents processed: ${processedCount}`);
    console.log(`- Documents updated: ${updatedCount}`);
    console.log(`- Documents skipped: ${skippedCount}`);
    console.log('\nRun this script again to process the next batch.');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the script
checkStandaloneAnswers(); 