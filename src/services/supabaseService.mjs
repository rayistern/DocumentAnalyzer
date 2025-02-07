import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

export async function saveAnalysis(content, type, result) {
  try {
    console.log(`Saving ${type} analysis to Supabase...`)
    
    // First save the document
    const { data: document, error: docError } = await supabase
      .from('documents')
      .insert({
        content,
        type,
        warnings: result.warnings || [],
        original_filename: result.filepath ? result.filepath.split('/').pop() : 'unknown',
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (docError) {
      console.error('Error saving document:', docError)
      throw new Error(`Supabase document error: ${docError.message}`)
    }

    // If it's a chunk type, save individual chunks
    if (type === 'chunk' && result.chunks) {
      const chunksToInsert = result.chunks.map(chunk => ({
        document_id: document.id,
        start_index: chunk.startIndex,
        end_index: chunk.endIndex,
        first_word: chunk.firstWord,
        last_word: chunk.lastWord,
        cleaned_text: chunk.cleanedText,
        original_text: chunk.originalText,
        warnings: Array.isArray(chunk.warnings) ? chunk.warnings.join('\n') : chunk.warnings,
        created_at: new Date().toISOString()
      }))

      const { error: chunksError } = await supabase
        .from('chunks')
        .insert(chunksToInsert)

      if (chunksError) {
        console.error('Error saving chunks:', chunksError)
        throw new Error(`Supabase chunks error: ${chunksError.message}`)
      }
    }

    console.log('Successfully saved document and chunks:', document.id)
    return document
  } catch (error) {
    console.error('Database error:', error.message)
    console.error('Full error:', error)
    throw error
  }
}

export async function getAnalysisByType(type) {
  try {
    console.log(`Fetching analyses of type: ${type}`)
    const { data: documents, error: docsError } = await supabase
      .from('documents')
      .select('*')
      .eq('type', type)
      .order('created_at', { ascending: false })

    if (docsError) throw new Error(`Supabase error: ${docsError.message}`)

    // If chunk type, fetch associated chunks
    if (type === 'chunk' && documents.length > 0) {
      const { data: chunks, error: chunksError } = await supabase
        .from('chunks')
        .select('*')
        .in('document_id', documents.map(d => d.id))
        .order('start_index', { ascending: true })

      if (chunksError) throw new Error(`Supabase error: ${chunksError.message}`)

      // Group chunks by document
      return documents.map(doc => ({
        ...doc,
        chunks: chunks.filter(chunk => chunk.document_id === doc.id)
      }))
    }

    return documents
  } catch (error) {
    console.error('Database error:', error.message)
    console.error('Full error:', error)
    throw error
  }
} 