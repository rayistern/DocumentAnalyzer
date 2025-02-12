import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { parseJsonResponse } from '../utils/jsonUtils.mjs'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

export { supabase };

export async function saveAnalysis(content, type, metadata = {}) {
    try {
        let documentSourceId;
        let document;
        
        // For initial document processing, create source record
        if (type === 'cleanAndChunk') {
            const { data: sourceData, error: sourceError } = await supabase
                .from('document_sources')
                .insert({
                    filename: metadata.filepath,
                    original_content: content,
                    status: 'processing'
                })
                .select()
                .single();
                
            if (sourceError) throw sourceError;
            documentSourceId = sourceData.id;

            // Save initial document
            const { data: docData, error: docError } = await supabase
                .from('documents')
                .insert({
                    content,
                    type,
                    warnings: metadata.warnings || [],
                    original_filename: metadata.filepath,
                    document_source_id: documentSourceId
                })
                .select()
                .single();

            if (docError) throw docError;
            document = docData;

        } else if (type === 'chunk' && metadata.document_source_id) {
            // For chunk processing, use existing document source id
            documentSourceId = metadata.document_source_id;
            document = metadata.document;
        } else {
            throw new Error('Invalid operation type or missing document source id');
        }

        // For chunks, save with source reference
        if (metadata.chunks && !metadata.skipChunkSave) {
            const chunksToInsert = metadata.chunks
                .filter(chunk => chunk.cleanedText && chunk.cleanedText.trim().length > 0)  // Filter out empty chunks
                .map(chunk => ({
                    document_id: document.id,
                    document_source_id: documentSourceId,
                    start_index: chunk.startIndex,
                    end_index: chunk.endIndex,
                    first_word: chunk.firstWord,
                    last_word: chunk.lastWord,
                    cleaned_text: chunk.cleanedText.trim(),
                    original_text: content.slice(chunk.startIndex - 1, chunk.endIndex),
                    warnings: Array.isArray(chunk.warnings) ? chunk.warnings.join('\n') : chunk.warnings,
                    raw_metadata: chunk.metadata || null,
                    created_at: new Date().toISOString()
                }));

            if (chunksToInsert.length > 0) {
                const { error: chunksError } = await supabase
                    .from('chunks')
                    .insert(chunksToInsert);

                if (chunksError) throw chunksError;
            }
        }

        // Update source status when cleaned content is ready
        if (type === 'cleanAndChunk' && content) {
            const { error: updateError } = await supabase
                .from('document_sources')
                .update({ 
                    cleaned_content: content,
                    status: 'processed'
                })
                .eq('id', documentSourceId);

            if (updateError) throw updateError;
        }

        return document;
    } catch (error) {
        console.error('Error saving to database:', error);
        throw error;
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

export async function saveCleanedDocument(documentId, cleanedText, originalText, model) {
    try {
        // Get the document source id from the original document
        const { data: document, error: docError } = await supabase
            .from('documents')
            .select('document_source_id')
            .eq('id', documentId)
            .single();
            
        if (docError) throw docError;

        // Update the document source with cleaned content
        const { error: updateError } = await supabase
            .from('document_sources')
            .update({ 
                cleaned_content: cleanedText,
                status: 'cleaned'
            })
            .eq('id', document.document_source_id);

        if (updateError) throw updateError;

        return { success: true };
    } catch (error) {
        console.error('Error saving cleaned document:', error);
        throw error;
    }
}

export async function saveChunkMetadata(documentId, chunkIndex, metadata) {
    try {
        console.log(`Saving metadata for document ${documentId}, chunk ${chunkIndex}...`);
        
        // Convert arrays to Postgres array format
        const formattedMetadata = {
            document_id: documentId,
            chunk_index: chunkIndex,
            long_summary: metadata.long_summary,
            short_summary: metadata.short_summary,
            quiz_questions: Array.isArray(metadata.quiz_questions) ? `{${metadata.quiz_questions.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            followup_thinking_questions: Array.isArray(metadata.followup_thinking_questions) ? `{${metadata.followup_thinking_questions.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            generated_title: metadata.generated_title,
            tags_he: Array.isArray(metadata.tags_he) ? `{${metadata.tags_he.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            key_terms_he: Array.isArray(metadata.key_terms_he) ? `{${metadata.key_terms_he.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            key_phrases_he: Array.isArray(metadata.key_phrases_he) ? `{${metadata.key_phrases_he.map(p => `"${p.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            key_phrases_en: Array.isArray(metadata.key_phrases_en) ? `{${metadata.key_phrases_en.map(p => `"${p.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            bibliography_snippets: Array.isArray(metadata.bibliography_snippets) ? `{${metadata.bibliography_snippets.map(b => `"${JSON.stringify(b).replace(/"/g, '\\"')}"`).join(',')}}` : null,
            questions_explicit: Array.isArray(metadata.questions_explicit) ? `{${metadata.questions_explicit.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            questions_implied: Array.isArray(metadata.questions_implied) ? `{${metadata.questions_implied.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            reconciled_issues: Array.isArray(metadata.reconciled_issues) ? `{${metadata.reconciled_issues.map(i => `"${i.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            qa_pair: metadata.qa_pair,
            potential_typos: Array.isArray(metadata.potential_typos) ? `{${metadata.potential_typos.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            identified_abbreviations: Array.isArray(metadata.identified_abbreviations) ? `{${metadata.identified_abbreviations.map(a => `"${a.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            named_entities: Array.isArray(metadata.named_entities) ? `{${metadata.named_entities.map(e => `"${e.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            created_at: new Date().toISOString()
        };

        const { error } = await supabase
            .from('chunk_metadata')
            .insert(formattedMetadata);

        if (error) {
            console.error('Error saving chunk metadata:', error);
            throw new Error(`Supabase metadata error: ${error.message}`);
        }

        console.log(`Successfully saved metadata for chunk ${chunkIndex}`);
    } catch (error) {
        console.error('Database error:', error.message);
        console.error('Full error:', JSON.stringify(error, null, 2));
        throw error;
    }
}