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

// Add this function to log all document_sources entries
export async function logAllDocumentSources() {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 📊 LOGGING ALL DOCUMENT_SOURCES ENTRIES`);
    
    try {
        const { data, error } = await supabase
            .from('document_sources')
            .select('id, filename, status, group_number, created_at')
            .order('created_at', { ascending: false })
            .limit(20);
            
        if (error) {
            console.error(`[${timestamp}] ❌ Error fetching document_sources:`, error);
            return;
        }
        
        console.log(`[${timestamp}] Found ${data.length} recent entries:`);
        data.forEach((entry, index) => {
            console.log(`[${timestamp}] ${index+1}. ID: ${entry.id.substring(0, 8)}... | Filename: ${entry.filename} | Status: ${entry.status} | Group: ${entry.group_number || 'none'} | Created: ${entry.created_at}`);
        });
    } catch (error) {
        console.error(`[${timestamp}] ❌ Error logging document_sources:`, error);
    }
}

// Add this function to check for duplicate entries
export async function checkForDuplicateEntries() {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 🔍 CHECKING FOR DUPLICATE ENTRIES`);
    
    try {
        // Find duplicate filenames
        const { data: duplicateFilenames, error: filenameError } = await supabase
            .rpc('find_duplicate_filenames');
            
        if (filenameError) {
            console.error(`[${timestamp}] ❌ Error checking for duplicate filenames:`, filenameError);
        } else if (duplicateFilenames?.length) {
            console.log(`[${timestamp}] ⚠️ Found ${duplicateFilenames.length} duplicate filenames:`);
            duplicateFilenames.forEach((dup, i) => {
                console.log(`[${timestamp}] ${i+1}. Filename: ${dup.filename} | Count: ${dup.count}`);
            });
        } else {
            console.log(`[${timestamp}] ✅ No duplicate filenames found`);
        }
        
        // Find duplicate content hashes
        const { data: duplicateHashes, error: hashError } = await supabase
            .rpc('find_duplicate_content_hashes');
            
        if (hashError) {
            console.error(`[${timestamp}] ❌ Error checking for duplicate content hashes:`, hashError);
        } else if (duplicateHashes?.length) {
            console.log(`[${timestamp}] ⚠️ Found ${duplicateHashes.length} duplicate content hashes:`);
            duplicateHashes.forEach((dup, i) => {
                console.log(`[${timestamp}] ${i+1}. Hash: ${dup.content_hash.substring(0, 8)}... | Count: ${dup.count}`);
            });
        } else {
            console.log(`[${timestamp}] ✅ No duplicate content hashes found`);
        }
    } catch (error) {
        console.error(`[${timestamp}] ❌ Error checking for duplicates:`, error);
    }
}

export async function saveAnalysis(content, type, metadata = {}) {
    try {
        let documentSourceId;
        let document;
        
        // Add detailed logging with timestamp and stack trace
        const timestamp = new Date().toISOString();
        const stackTrace = new Error().stack;
        console.log(`\n[${timestamp}] 📝 DATABASE OPERATION: saveAnalysis`);
        console.log(`Type: ${type}`);
        console.log(`Filepath: ${metadata.filepath || 'none'}`);
        console.log(`GroupNumber: ${metadata.groupNumber || 'none'}`);
        console.log(`Content length: ${content ? content.length : 0} chars`);
        console.log(`Call stack: ${stackTrace.split('\n').slice(1, 6).join('\n')}`);
        
        // For initial document processing or skipped duplicates, create source record
        if (type === 'cleanAndChunk' || type === 'fullMetadata_only' || type === 'skipped_duplicate') {
            console.log(`[${timestamp}] 📥 CREATING NEW document_source and document records`);
            
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
                console.error(`[${timestamp}] ❌ ERROR creating document_source:`, sourceError);
                throw sourceError;
            }
            documentSourceId = sourceData.id;
            console.log(`[${timestamp}] ✅ Created document_source with ID: ${documentSourceId}`);

            // Calculate content hash
            const contentHash = calculateContentHash(content);
            console.log(`[${timestamp}] Content hash: ${contentHash}`);

            // Save initial document
            console.log(`[${timestamp}] 📥 CREATING document record with type=${type}, status=${type === 'skipped_duplicate' ? 'skipped_duplicate' : 'pending'}`);
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
                console.error(`[${timestamp}] ❌ ERROR creating document:`, docError);
                throw docError;
            }
            document = docData;
            console.log(`[${timestamp}] ✅ Created document with ID: ${document.id}, document_source_id: ${document.document_source_id}`);
        } else if (metadata.document_source_id) {
            // For chunk processing, use existing document source id
            documentSourceId = metadata.document_source_id;
            document = metadata.document;
            console.log(`[${timestamp}] Using existing document_source_id: ${documentSourceId}`);
        } else {
            console.error(`[${timestamp}] ❌ Invalid operation type or missing document source id`);
            throw new Error('Invalid operation type or missing document source id');
        }

        // Check if document_source_id is available - if not, try to get it directly
        if (!documentSourceId && document && document.id) {
            console.log(`[${timestamp}] ⚠️ WARNING: Missing documentSourceId but have document.id - trying to fetch documentSourceId`);
            try {
                const { data, error } = await supabase
                    .from('documents')
                    .select('document_source_id')
                    .eq('id', document.id)
                    .single();
                
                if (error) {
                    console.error(`[${timestamp}] ❌ Error fetching document_source_id:`, error);
                } else if (data && data.document_source_id) {
                    console.log(`[${timestamp}] 🔄 Retrieved document_source_id: ${data.document_source_id} for document ${document.id}`);
                    documentSourceId = data.document_source_id;
                } else {
                    console.error(`[${timestamp}] ❌ Could not retrieve document_source_id from database`);
                }
            } catch (fetchError) {
                console.error(`[${timestamp}] ❌ Error during document_source_id fetch:`, fetchError);
            }
        }

        // For chunks, save with source reference
        if (metadata.chunks && !metadata.skipChunkSave) {
            console.log(`[${timestamp}] ========== CHUNK SAVING DIAGNOSTICS ==========`);
            console.log(`[${timestamp}] 📥 INSERTING ${metadata.chunks.length} chunks via saveAnalysis call`);
            console.log(`[${timestamp}] Document ID: ${document?.id || 'MISSING!'}`);
            console.log(`[${timestamp}] Document Source ID: ${documentSourceId || 'MISSING!'}`);
            
            // Check input chunks
            if (metadata.chunks.length > 0) {
                console.log(`[${timestamp}] Sample input chunk:`, {
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
                        created_at: new Date().toISOString(),
                        within_tolerance: chunk.within_tolerance,
                        position_difference: chunk.position_difference,
                        llm_suggested_end: chunk.llm_suggested_end,
                        actual_end: chunk.actual_end,
                        first_word_match: chunk.first_word_match,
                        last_word_match: chunk.last_word_match
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
                console.log(`[${timestamp}] First chunk to insert:`, {
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
            console.log(`[${timestamp}] 🔄 UPDATING document_source status to 'processed'`);
            const { error: updateError } = await supabase
                .from('document_sources')
                .update({ 
                    cleaned_content: content,
                    status: 'processed'
                })
                .eq('id', documentSourceId);

            if (updateError) {
                console.error(`[${timestamp}] ❌ Error updating document source:`, updateError);
                throw updateError;
            }
            console.log(`[${timestamp}] ✅ Updated document_source status to 'processed'`);
        }

        return document;
    } catch (error) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] ❌ ERROR in saveAnalysis:`, error);
        console.error(`[${timestamp}] Error stack:`, error.stack);
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
        
        // Map LLM response fields to database fields if needed
        const mappedMetadata = {
            long_summary: metadata.long_summary || metadata.longSummary,
            short_summary: metadata.short_summary || metadata.shortSummary,
            quiz_questions: metadata.quiz_questions || metadata.quizQuestions,
            followup_thinking_questions: metadata.followup_thinking_questions || metadata.followupThinkingQuestions,
            generated_title: metadata.generated_title || metadata.generatedTitle,
            tags_he: metadata.tags_he || metadata.tagsHe,
            key_terms_he: metadata.key_terms_he || metadata.keyTermsHe,
            key_phrases_he: metadata.key_phrases_he || metadata.keyPhrasesHe,
            key_phrases_en: metadata.key_phrases_en || metadata.keyPhrasesEn,
            // Skip problematic fields
            questions_explicit: metadata.questions_explicit || metadata.questionsExplicit,
            questions_implied: metadata.questions_implied || metadata.questionsImplied,
            reconciled_issues: metadata.reconciled_issues || metadata.reconciledIssues,
            qa_pair: metadata.qa_pair || metadata.qaPair,
            potential_typos: metadata.potential_typos || metadata.potentialTypos,
            named_entities: metadata.named_entities || metadata.namedEntities
        };
        
        console.log(`Mapped metadata fields for chunk ${chunkIndex}`);
        
        // Convert arrays to Postgres array format
        const formattedMetadata = {
            document_id: documentId,
            chunk_index: chunkIndex,
            long_summary: mappedMetadata.long_summary,
            short_summary: mappedMetadata.short_summary,
            quiz_questions: Array.isArray(mappedMetadata.quiz_questions) ? `{${mappedMetadata.quiz_questions.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            followup_thinking_questions: Array.isArray(mappedMetadata.followup_thinking_questions) ? `{${mappedMetadata.followup_thinking_questions.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            generated_title: mappedMetadata.generated_title,
            tags_he: Array.isArray(mappedMetadata.tags_he) ? `{${mappedMetadata.tags_he.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            key_terms_he: Array.isArray(mappedMetadata.key_terms_he) ? `{${mappedMetadata.key_terms_he.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            key_phrases_he: Array.isArray(mappedMetadata.key_phrases_he) ? `{${mappedMetadata.key_phrases_he.map(p => `"${p.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            key_phrases_en: Array.isArray(mappedMetadata.key_phrases_en) ? `{${mappedMetadata.key_phrases_en.map(p => `"${p.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            // Skip problematic fields
            questions_explicit: Array.isArray(mappedMetadata.questions_explicit) ? `{${mappedMetadata.questions_explicit.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            questions_implied: Array.isArray(mappedMetadata.questions_implied) ? `{${mappedMetadata.questions_implied.map(q => `"${q.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            reconciled_issues: Array.isArray(mappedMetadata.reconciled_issues) ? `{${mappedMetadata.reconciled_issues.map(i => `"${i.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            qa_pair: mappedMetadata.qa_pair ? JSON.stringify(mappedMetadata.qa_pair) : null,
            potential_typos: Array.isArray(mappedMetadata.potential_typos) ? `{${mappedMetadata.potential_typos.map(t => `"${t.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            named_entities: Array.isArray(mappedMetadata.named_entities) ? `{${mappedMetadata.named_entities.map(e => `"${e.replace(/"/g, '\\"')}"`).join(',')}}` : null,
            created_at: new Date().toISOString()
        };

        // Log metadata fields before saving
        console.log(`Preparing to save metadata for chunk ${chunkIndex} with fields:`, 
            Object.keys(formattedMetadata).filter(k => formattedMetadata[k] !== null).join(', '));

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