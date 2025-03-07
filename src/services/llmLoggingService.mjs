import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Global timeout setting in hours
const GLOBAL_TIMEOUT_HOURS = 10;

// Add automatic timeout function
function setupProcessTimeout(hours = GLOBAL_TIMEOUT_HOURS) {
    const timeoutMs = hours * 60 * 60 * 1000; // Convert hours to milliseconds
    console.log(`\n[${new Date().toISOString()}] ⏱️ Setting up automatic timeout after ${hours} hours`);
    
    setTimeout(() => {
        console.log(`\n[${new Date().toISOString()}] ⏱️ AUTOMATIC TIMEOUT TRIGGERED after ${hours} hours`);
        console.log(`[${new Date().toISOString()}] Process is being terminated to prevent runaway execution`);
        process.exit(0);
    }, timeoutMs);
}

// Set up the global timeout for all processes
setupProcessTimeout();


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

export async function logLLMResponse(prompt, response, model) {
  try {
    const { error } = await supabase
      .from('llm_logs')
      .insert({
        prompt,
        response,
        model,
        created_at: new Date().toISOString()
      })

    if (error) {
      console.error('Supabase logging error:', error)
      throw error
    }
    console.log('Successfully logged LLM response')
  } catch (error) {
    console.error('Failed to log LLM response:', error.message)
    console.error('Full error:', error)
  }
}