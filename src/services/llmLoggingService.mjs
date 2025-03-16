import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { setupProcessTimeout } from '../config.mjs';

dotenv.config()


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