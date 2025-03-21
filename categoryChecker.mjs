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
const MODEL = "gpt-4.5-preview"; // Model to use for evaluation

// Sleep function to add delay between operations
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Main function
async function categorizeQuestions() {
  console.log('Starting question categorization process...');
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
      .is('category', null)
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
      This is a QA pair to be used in training a model. Please categorize this question and answer into exactly ONE of the following categories:
      
      - ACADEMIC: Explaining or clarifying concepts in Torah or Mitzvot on an academic level.
      - EDUCATION: Discussing the teaching of children or adults.
      - SHLICHUT: Discussing the mission on each person to spread Chassidus and light and goodness throughout the world.
      - FESTIVALS: Letters for the holidays or for calendar days of celebration.
      - BELIEF: Trust and faith in God, and overcoming such challenges and doubts.
      - MARRIAGE: Discussing marriage, family, or domestic matters, including engagement, dating, divorce, etc.
      - HEALTH: Health related questions and answers. Including disabilities and injuries.
      - MONEY: Business, work, and financial matters.
      - CHARITY
      - JOY: Discussing happiness and joy, as well as the inverse, addressing feelings of sadness, depression, or inadiquacy, etc.
      - PURPOSE: Discussion meaning in life, satisfaction, frustration, and so on.
      - POLITICS: Local, official, or any other negotiations or disputes
      - SCIENCE
      - ISRAEL: The land of Israel, including historical and modern issues
      - CHILDREN: Raising children and the stages in their development. Also letters addressed to children.
      - FERTILITY: Advice and guidance for pregnancy, birth, and infirtility issues.
      - LIFECYCLE: Grief and mourning, tragedy, condolence, and so on.
      - MOSHIACH: The future redemption, the third holy temple, reincarnation, etc., as well as the mourning over the destruction of the temple and so on.
      - CHASSIDUT: The Chabad perspective, mysticism, historical notes, and the light which this method shines on all of life. Including deeper philosophical questions like free choice, repentence, etc. Only letters which do not fit elsewhere.
      - HALACHA: Including traditions and technical situations.
      - GROWTH: Self-help and character improvement; therapy and guidance
      - SOCIETY: Discussion beyond the realm of Judaism, such as humanity at large, the mission of all people, and so on.

      Respond only the one word category name from the list above (e.g., "MARRIAGE").`;
      
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
        const validCategories = ['ACADEMIC', 'EDUCATION', 'GROWTH', 'SHLICHUT', 'FESTIVALS', 'BELIEF', 'MARRIAGE', 'HEALTH', 'MONEY', 'CHARITY', 'JOY', 'PURPOSE', 'POLITICS', 'SCIENCE', 'ISRAEL', 'CHILDREN', 'FERTILITY', 'LIFECYCLE', 'MOSHIACH', 'CHASSIDUT', 'HALACHA', 'SOCIETY'];
        const category = result.toUpperCase();
        
        if (validCategories.includes(category)) {
          // Update the document
          const { error: updateError } = await supabase
            .from('documents')
            .update({ category: category })
            .eq('id', doc.id);
          
          if (updateError) {
            console.error(`Error updating document ${doc.id}:`, updateError);
            skippedCount++;
          } else {
            console.log(`Successfully updated document ${doc.id} with category = ${category}`);
            updatedCount++;
          }
        } else {
          console.log(`Warning: Unexpected category for document ${doc.id}: "${result}"`);
          skippedCount++;
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
categorizeQuestions(); 