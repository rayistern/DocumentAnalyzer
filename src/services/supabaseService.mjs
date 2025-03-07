import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { parseJsonResponse } from '../utils/jsonUtils.mjs'
import { calculateContentHash } from '../utils/deduplication.mjs'

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
        
        console.log(`saveAnalysis called with type: ${type}, filepath: ${metadata.filepath || 'none'}, groupNumber: ${metadata.groupNumber || 'none'}`);
        
        // For initial document processing or skipped duplicates, create source record
        if (type === 'cleanAndChunk' || type === 'fullMetadata_only' || type === 'skipped_duplicate') {
            const { data: sourceData, error: sourceError } = await supabase
                .from('document_sources')
                .insert({
                    filename: metadata.filepath,
                    original_content: content,
                    status: type === 'skipped_duplicate' ? 'skipped' : type,
                    group_number: metadata.groupNumber
                })
                .select()
                .single();
                
            if (sourceError) {
                console.error('Error creating document_source:', sourceError);
                throw sourceError;
            }
            documentSourceId = sourceData.id;
            console.log(`Created document_source with ID: ${documentSourceId}`);

            // Calculate content hash
            const contentHash = calculateContentHash(content);

            // Save initial document
            const { data: docData, error: docError } = await supabase
                .from('documents')
                .insert({
                    content,
                    type,
                    warnings: metadata.warnings || [],
                    original_filename: metadata.filepath,
                    document_source_id: documentSourceId,
                    content_hash: contentHash,
                    status: type === 'skipped_duplicate' ? 'skipped_duplicate' : 'pending',
                    duplicate_of: type === 'skipped_duplicate' ? metadata.duplicate_of : null
                })
                .select()
                .single();

            if (docError) {
                console.error('Error creating document:', docError);
                throw docError;
            }
            document = docData;
            console.log(`Created document with ID: ${document.id}, document_source_id: ${document.document_source_id}`);
        } else if (metadata.document_source_id) {
            // For chunk processing, use existing document source id
            documentSourceId = metadata.document_source_id;
            document = metadata.document;
        } else {
            throw new Error('Invalid operation type or missing document source id');
        }

        // Check if document_source_id is available - if not, try to get it directly
        if (!documentSourceId && document && document.id) {
            console.log(`⚠️ WARNING: Missing documentSourceId but have document.id - trying to fetch documentSourceId`);
            try {
                const { data, error } = await supabase
                    .from('documents')
                    .select('document_source_id')
                    .eq('id', document.id)
                    .single();
                
                if (error) {
                    console.error('Error fetching document_source_id:', error);
                } else if (data && data.document_source_id) {
                    console.log(`🔄 Retrieved document_source_id: ${data.document_source_id} for document ${document.id}`);
                    documentSourceId = data.document_source_id;
                } else {
                    console.error('❌ Could not retrieve document_source_id from database');
                }
            } catch (fetchError) {
                console.error('Error during document_source_id fetch:', fetchError);
            }
        }

        // For chunks, save with source reference
        if (metadata.chunks && !metadata.skipChunkSave) {
            console.log(`========== CHUNK SAVING DIAGNOSTICS ==========`);
            console.log(`Attempting to save ${metadata.chunks.length} chunks via saveAnalysis call`);
            console.log(`Document ID: ${document?.id || 'MISSING!'}`);
            console.log(`Document Source ID: ${documentSourceId || 'MISSING!'}`);
            
            // Check input chunks
            if (metadata.chunks.length > 0) {
                console.log(`Sample input chunk:`, {
                    startIndex: metadata.chunks[0].startIndex,
                    endIndex: metadata.chunks[0].endIndex,
                    cleanedText: metadata.chunks[0].cleanedText?.substring(0, 50) + '...',
                    firstWord: metadata.chunks[0].firstWord,
                    lastWord: metadata.chunks[0].lastWord,
                    textLength: metadata.chunks[0].cleanedText?.length || 0
                });
            }
            
            const chunksToInsert = metadata.chunks
                .filter(chunk => {
                    // More robust filtering logic
                    if (!chunk.startIndex || !chunk.endIndex) {
                        console.log(`⚠️ Filtered out chunk: missing position info`);
                        return false;
                    }
                    
                    // Check if positions are valid
                    if (chunk.startIndex >= chunk.endIndex) {
                        console.log(`⚠️ Filtered out chunk: startIndex=${chunk.startIndex} >= endIndex=${chunk.endIndex} (invalid positions)`);
                        return false;
                    }
                    
                    // Check if text is completely missing
                    if (!chunk.cleanedText) {
                        console.log(`⚠️ Filtered out chunk: startIndex=${chunk.startIndex}, endIndex=${chunk.endIndex} (completely missing text)`);
                        return false;
                    }
                    
                    // If text is only whitespace, log warning but keep the chunk
                    if (chunk.cleanedText.trim().length === 0) {
                        console.log(`⚠️ WARNING: Chunk contains only whitespace - positions: ${chunk.startIndex}-${chunk.endIndex}`);
                        // Still include it but trim the whitespace
                        chunk.cleanedText = '';
                    }
                    
                    return true;
                })
                .map(chunk => {
                    // Additional position validation logging
                    const startIndex = chunk.startIndex || 0;
                    const endIndex = chunk.endIndex || 0;
                    
                    if (startIndex >= endIndex) {
                        console.log(`⚠️ Warning: Invalid chunk positions (start=${startIndex} >= end=${endIndex})`);
                    }
                    
                    if (!chunk.firstWord || !chunk.lastWord) {
                        console.log(`⚠️ Warning: Missing boundary words for chunk ${startIndex}-${endIndex}`);
                    }
                    
                    const chunkData = {
                        document_id: document.id,
                        document_source_id: documentSourceId,
                        start_index: startIndex,
                        end_index: endIndex,
                        first_word: chunk.firstWord,
                        last_word: chunk.lastWord,
                        cleaned_text: (chunk.cleanedText || '').trim(),
                        original_text: content.slice(Math.max(0, startIndex - 1), Math.min(content.length, endIndex)),
                        warnings: Array.isArray(chunk.warnings) ? chunk.warnings.join('\n') : chunk.warnings,
                        raw_metadata: chunk.metadata || null,
                        created_at: new Date().toISOString()
                    };
                    
                    // Validate all fields
                    Object.entries(chunkData).forEach(([key, value]) => {
                        if (value === undefined || value === null) {
                            console.error(`⚠️ WARNING: Field "${key}" is ${value} in chunk data`);
                        }
                    });
                    
                    return chunkData;
                });

            console.log(`After filtering/processing: ${chunksToInsert.length} chunks ready to insert`);
            
            if (chunksToInsert.length > 0) {
                console.log(`First chunk to insert:`, {
                    document_id: chunksToInsert[0].document_id,
                    document_source_id: chunksToInsert[0].document_source_id,
                    start_index: chunksToInsert[0].start_index,
                    end_index: chunksToInsert[0].end_index,
                    first_word: chunksToInsert[0].first_word,
                    last_word: chunksToInsert[0].last_word,
                    text_length: chunksToInsert[0].cleaned_text?.length || 0
                });
                
                try {
                    const { data, error: chunksError } = await supabase
                        .from('chunks')
                        .insert(chunksToInsert)
                        .select();

                    if (chunksError) {
                        console.error('🚨 ERROR saving chunks in saveAnalysis:', chunksError);
                        console.error('Error code:', chunksError.code);
                        console.error('Error details:', chunksError.details);
                        console.error('Error hint:', chunksError.hint);
                        throw chunksError;
                    } else {
                        console.log(`✅ SUCCESS: ${chunksToInsert.length} chunks saved successfully from saveAnalysis call`);
                        if (data) {
                            console.log(`Returned data: ${data.length} rows`);
                        }
                    }
                } catch (insertError) {
                    console.error('🚨 EXCEPTION during chunk insert:', insertError);
                    if (insertError.code) {
                        console.error(`SQL Error Code: ${insertError.code}`);
                    }
                    throw insertError;
                }
            } else {
                console.log('⚠️ No valid chunks to insert after filtering');
            }
            console.log(`========== END CHUNK DIAGNOSTICS ==========`);
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

            if (updateError) {
                console.error('Error updating document source:', updateError);
                throw updateError;
            }
        }

        return document;
    } catch (error) {
        console.error('Error in saveAnalysis:', error);
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