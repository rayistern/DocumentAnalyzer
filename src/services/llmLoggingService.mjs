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

export async function logLLMResponse(prompt, response, model, usage = null) {
  try {
    const { error } = await supabase
      .from('llm_logs')
      .insert({
        prompt,
        response,
        model,
        created_at: new Date().toISOString(),
        input_tokens: usage?.prompt_tokens || null,
        output_tokens: usage?.completion_tokens || null,
        total_tokens: usage?.total_tokens || null,
        reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens || null,
        cached_tokens: usage?.prompt_tokens_details?.cached_tokens || null
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