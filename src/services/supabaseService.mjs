import pkg from '@supabase/supabase-js';
const { createClient } = pkg;
import dotenv from 'dotenv'
import { parseJsonResponse } from '../utils/jsonUtils.mjs'
import { calculateContentHash } from '../utils/deduplication.mjs'
import path from 'path'
import { setupProcessTimeout } from '../config.mjs'

dotenv.config()

// Set up the global timeout for all processes
setupProcessTimeout();

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
        
        // Check for any entries created in the last 10 seconds
        const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
        const recentEntries = data.filter(entry => entry.created_at > tenSecondsAgo);
        
        if (recentEntries.length > 0) {
            console.log(`\n[${timestamp}] ⚠️ ALERT: Found ${recentEntries.length} entries created in the last 10 seconds:`);
            recentEntries.forEach((entry, index) => {
                console.log(`[${timestamp}] ${index+1}. ID: ${entry.id.substring(0, 8)}... | Filename: ${entry.filename} | Status: ${entry.status} | Group: ${entry.group_number || 'none'} | Created: ${entry.created_at}`);
            });
            console.log(`[${timestamp}] These entries may have been created by another process or by an unexpected code path.`);
        }
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

// Add a function to detect unexpected document entries
export async function detectUnexpectedEntries(expectedFilename) {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 🔍 CHECKING FOR UNEXPECTED ENTRIES`);
    
    try {
        // Get the 5 most recent entries
        const { data, error } = await supabase
            .from('document_sources')
            .select('id, filename, status, group_number, created_at')
            .order('created_at', { ascending: false })
            .limit(5);
            
        if (error) {
            console.error(`[${timestamp}] ❌ Error fetching recent entries:`, error);
            return;
        }
        
        // Check if any entries don't match the expected filename
        const unexpectedEntries = data.filter(entry => {
            // If we're expecting a specific filename, filter for entries that don't match
            if (expectedFilename) {
                const baseExpectedFilename = expectedFilename.includes('/') || expectedFilename.includes('\\') 
                    ? path.basename(expectedFilename) 
                    : expectedFilename;
                    
                const baseEntryFilename = entry.filename.includes('/') || entry.filename.includes('\\') 
                    ? path.basename(entry.filename) 
                    : entry.filename;
                    
                return baseEntryFilename !== baseExpectedFilename;
            }
            
            // If no expected filename, just return all entries
            return true;
        });
        
        if (unexpectedEntries.length > 0) {
            console.log(`[${timestamp}] ⚠️ ALERT: Found ${unexpectedEntries.length} unexpected entries:`);
            unexpectedEntries.forEach((entry, index) => {
                console.log(`[${timestamp}] ${index+1}. ID: ${entry.id.substring(0, 8)}... | Filename: ${entry.filename} | Status: ${entry.status} | Group: ${entry.group_number || 'none'} | Created: ${entry.created_at}`);
            });
            console.log(`[${timestamp}] These entries may have been created by another process or by an unexpected code path.`);
            
            // Check for specific patterns in the unexpected entries
            const suspiciousEntries = unexpectedEntries.filter(entry => 
                entry.group_number && 
                entry.group_number.includes('igrosgpt4.5-1a') && 
                !entry.group_number.includes('test')
            );
            
            if (suspiciousEntries.length > 0) {
                console.log(`\n[${timestamp}] 🚨 CRITICAL ALERT: Found ${suspiciousEntries.length} entries with suspicious group numbers:`);
                suspiciousEntries.forEach((entry, index) => {
                    console.log(`[${timestamp}] ${index+1}. ID: ${entry.id.substring(0, 8)}... | Filename: ${entry.filename} | Group: ${entry.group_number}`);
                });
                console.log(`[${timestamp}] These entries match the pattern of the unexpected entries you're seeing.`);
                console.log(`[${timestamp}] This suggests there might be a database trigger or another process creating these entries.`);
                
                // Log a stack trace to help identify where this is being called from
                console.log(`[${timestamp}] Current call stack:`);
                console.log(new Error().stack);
            }
        } else {
            console.log(`[${timestamp}] ✅ No unexpected entries found.`);
        }
    } catch (error) {
        console.error(`[${timestamp}] ❌ Error detecting unexpected entries:`, error);
    }
}

// Add a function to check for database triggers
export async function checkForDatabaseTriggers() {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 🔍 CHECKING FOR DATABASE TRIGGERS`);
    
    try {
        // Query for triggers in the database
        const { data, error } = await supabase.rpc('list_triggers');
        
        if (error) {
            console.error(`[${timestamp}] ❌ Error checking for triggers:`, error);
            console.log(`[${timestamp}] This database may not have the list_triggers function. Creating a simple query to check...`);
            
            // Try a simpler query to check for triggers
            const { data: pgData, error: pgError } = await supabase
                .from('pg_trigger')
                .select('*')
                .limit(10);
                
            if (pgError) {
                console.error(`[${timestamp}] ❌ Error querying pg_trigger:`, pgError);
                console.log(`[${timestamp}] Unable to check for triggers directly. Please check your database configuration.`);
            } else if (pgData && pgData.length > 0) {
                console.log(`[${timestamp}] ⚠️ Found ${pgData.length} triggers in the database:`);
                pgData.forEach((trigger, index) => {
                    console.log(`[${timestamp}] ${index+1}. Trigger: ${JSON.stringify(trigger)}`);
                });
            } else {
                console.log(`[${timestamp}] ✅ No triggers found in pg_trigger.`);
            }
            
            return;
        }
        
        if (data && data.length > 0) {
            console.log(`[${timestamp}] ⚠️ Found ${data.length} triggers in the database:`);
            data.forEach((trigger, index) => {
                console.log(`[${timestamp}] ${index+1}. Trigger: ${JSON.stringify(trigger)}`);
            });
        } else {
            console.log(`[${timestamp}] ✅ No triggers found.`);
        }
    } catch (error) {
        console.error(`[${timestamp}] ❌ Error checking for triggers:`, error);
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
        
        // Check if this file is already being processed by another instance
        if (metadata.filepath && (type === 'cleanAndChunk' || type === 'fullMetadata_only')) {
            const baseFilename = metadata.filepath.includes('/') || metadata.filepath.includes('\\') 
                ? path.basename(metadata.filepath) 
                : metadata.filepath;
                
            console.log(`[${timestamp}] 🔒 Checking for concurrent processing of ${baseFilename}...`);
            
            // Look for very recent entries (last 30 seconds) with this filename
            const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
            const { data: recentData, error: recentError } = await supabase
                .from('document_sources')
                .select('id, filename, status, group_number, created_at')
                .or(`filename.eq.${baseFilename},filename.ilike.%${baseFilename}`)
                .gt('created_at', thirtySecondsAgo);
                
            if (!recentError && recentData?.length) {
                console.log(`[${timestamp}] ⚠️ WARNING: Found ${recentData.length} very recent entries for this file (created in last 30 seconds):`);
                recentData.forEach((doc, i) => {
                    console.log(`[${timestamp}]   ${i+1}. ID: ${doc.id} | Filename: ${doc.filename} | Status: ${doc.status} | Group: ${doc.group_number || 'none'} | Created: ${doc.created_at}`);
                });
                console.log(`[${timestamp}] ⚠️ Possible concurrent processing detected - continuing but with caution`);
            }
        }
        
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

            // Extract header (first line)
            const header = content.split('\n')[0];
            console.log(`[${timestamp}] Extracted header: "${header.substring(0, Math.min(50, header.length))}${header.length > 50 ? '...' : ''}"`);

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
                    duplicate_of: type === 'skipped_duplicate' ? metadata.duplicate_of : null,
                    category: null,
                    header
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
            
            const rows = metadata.chunks.map(c => buildChunkRow(c, document.id));
            
            console.log(`After filtering/processing: ${rows.length} chunks ready to insert`);
            
            if (rows.length > 0) {
                console.log(`[${timestamp}] First chunk to insert:`, {
                    document_id: rows[0].document_id,
                    document_source_id: rows[0].document_source_id,
                    start_index: rows[0].start_index,
                    end_index: rows[0].end_index,
                    first_word: rows[0].first_word,
                    last_word: rows[0].last_word,
                    text_length: rows[0].cleaned_text?.length || 0
                });
                
                try {
                    const { data, error: chunksError } = await supabase
                        .from('chunks')
                        .insert(rows)
                        .select();

                    if (chunksError) {
                        console.error('🚨 ERROR saving chunks in saveAnalysis:', chunksError);
                        console.error('Error code:', chunksError.code);
                        console.error('Error details:', chunksError.details);
                        console.error('Error hint:', chunksError.hint);
                        throw chunksError;
                    } else {
                        console.log(`✅ SUCCESS: ${rows.length} chunks saved successfully from saveAnalysis call`);
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

export async function saveCleanedDocument(documentId, cleanedText, originalText, model, apiTokens = null) {
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

        // Insert into cleaned_documents table
        console.log(`[${new Date().toISOString()}] 🔄 Inserting entry into cleaned_documents table for document ${documentId}`);
        
        // Create token usage object for logging
        const tokenUsage = {
            input_tokens: apiTokens?.prompt_tokens || null,
            output_tokens: apiTokens?.completion_tokens || null,
            total_tokens: apiTokens?.total_tokens || null,
            reasoning_tokens: apiTokens?.completion_tokens_details?.reasoning_tokens || null,
            cached_tokens: apiTokens?.prompt_tokens_details?.cached_tokens || null
        };
        
        // Log token usage
        console.log(`[${new Date().toISOString()}] 📊 TOKEN USAGE for document cleaning:`, {
            ...tokenUsage,
            raw_usage_object: apiTokens ? JSON.stringify(apiTokens) : 'N/A'
        });
        
        // Insert the data
        const { error: insertError } = await supabase
            .from('cleaned_documents')
            .insert({
                id: documentId,
                cleaned_content: cleanedText,
                original_document: originalText,
                llm_model: model,
                input_tokens: tokenUsage.input_tokens,
                output_tokens: tokenUsage.output_tokens,
                total_tokens: tokenUsage.total_tokens,
                reasoning_tokens: tokenUsage.reasoning_tokens,
                cached_tokens: tokenUsage.cached_tokens
            });
            
        if (insertError) {
            console.error(`[${new Date().toISOString()}] ❌ ERROR inserting into cleaned_documents:`, insertError);
        } else {
            console.log(`[${new Date().toISOString()}] ✅ Successfully saved to cleaned_documents table`);
        }

        return { success: true };
    } catch (error) {
        console.error('Error saving cleaned document:', error);
        throw error;
    }
}

/**
 * Saves metadata for a chunk
 * 
 * @param {string} documentId - The document ID
 * @param {number} chunkIndex - The index of the chunk
 * @param {object} metadata - The metadata object
 * @param {string} model - The model used to generate metadata
 * @param {string} rawResponse - The raw LLM response
 * @param {object} apiMetadata - Additional API metadata
 * @returns {Promise} - A promise that resolves when the metadata is saved
 */
export async function saveChunkMetadata(documentId, chunkIndex, metadata, model, rawResponse, apiMetadata = {}) {
    try {
        // First find the actual chunk ID using document ID and chunk index
        const { data: chunks, error: chunkError } = await supabase
            .from('chunks')
            .select('id')
            .eq('document_id', documentId)
            .order('id', { ascending: true });
            
        if (chunkError) {
            console.error(`Error finding chunk for metadata: ${chunkError.message}`);
            return;
        }
        
        if (!chunks || chunks.length === 0) {
            console.error(`No chunks found for document ${documentId}`);
            return;
        }
        
        // Get the chunk at the specified index, or the last chunk if index is too large
        const chunk = chunks[Math.min(chunkIndex, chunks.length - 1)];
        
        if (!chunk) {
            console.error(`Chunk at index ${chunkIndex} not found for document ${documentId}`);
            return;
        }
        
        // Now update the chunk with metadata
        const { error: updateError } = await supabase
            .from('chunks')
            .update({
                metadata: metadata,
                raw_metadata: rawResponse,
                metadata_model: model,
                api_metadata: apiMetadata,
                updated_at: new Date().toISOString(),
                // Add any new token usage fields if they exist in apiMetadata
                metadata_input_tokens: apiMetadata?.usage?.prompt_tokens || null,
                metadata_output_tokens: apiMetadata?.usage?.completion_tokens || null,
                metadata_total_tokens: apiMetadata?.usage?.total_tokens || null
            })
            .eq('id', chunk.id);
            
        if (updateError) {
            console.error(`Error saving chunk metadata: ${updateError.message}`);
            return;
        }
        
        console.log(`Successfully saved metadata for chunk ${chunk.id}`);
    } catch (error) {
        console.error(`Exception in saveChunkMetadata: ${error.message}`);
    }
}

// Add a function to check for recent database activity
export async function checkForRecentActivity() {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 🔍 CHECKING FOR RECENT DATABASE ACTIVITY`);
    
    try {
        // Get the last 20 entries from document_sources
        const { data: sourceData, error: sourceError } = await supabase
            .from('document_sources')
            .select('id, filename, status, group_number, created_at')
            .order('created_at', { ascending: false })
            .limit(20);
            
        if (sourceError) {
            console.error(`[${timestamp}] ❌ Error fetching recent document_sources:`, sourceError);
            return;
        }
        
        // Group entries by group_number
        const groupedEntries = {};
        sourceData.forEach(entry => {
            const group = entry.group_number || 'none';
            if (!groupedEntries[group]) {
                groupedEntries[group] = [];
            }
            groupedEntries[group].push(entry);
        });
        
        console.log(`[${timestamp}] Recent activity by group:`);
        Object.keys(groupedEntries).forEach(group => {
            const entries = groupedEntries[group];
            console.log(`[${timestamp}] Group: ${group} - ${entries.length} entries`);
            
            // Check if there are very recent entries (last 5 minutes)
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            const recentEntries = entries.filter(entry => entry.created_at > fiveMinutesAgo);
            
            if (recentEntries.length > 0) {
                console.log(`[${timestamp}] ⚠️ Found ${recentEntries.length} very recent entries (last 5 minutes) in group ${group}:`);
                recentEntries.forEach((entry, index) => {
                    console.log(`[${timestamp}]   ${index+1}. ID: ${entry.id.substring(0, 8)}... | Filename: ${entry.filename} | Created: ${entry.created_at}`);
                });
                console.log(`[${timestamp}] This suggests there might be another process running with group: ${group}`);
            }
        });
        
        // Check for suspicious patterns
        const suspiciousGroups = Object.keys(groupedEntries).filter(group => 
            group.includes('igrosgpt4.5-1a') && !group.includes('test')
        );
        
        if (suspiciousGroups.length > 0) {
            console.log(`\n[${timestamp}] 🚨 CRITICAL ALERT: Found activity in suspicious groups:`);
            suspiciousGroups.forEach(group => {
                console.log(`[${timestamp}] Group: ${group} - ${groupedEntries[group].length} entries`);
            });
            console.log(`[${timestamp}] These groups match the pattern of the unexpected entries you're seeing.`);
            console.log(`[${timestamp}] This suggests there might be another process running with these groups.`);
        }
    } catch (error) {
        console.error(`[${timestamp}] ❌ Error checking for recent activity:`, error);
    }
}

// Define the function to build a chunk row for database insertion
function buildChunkRow(chunk, docId) {
  return {
    document_id: docId,
    start_index: chunk.startIndex,
    end_index: chunk.endIndex,
    chunk_index: chunk.chunkIndex ?? null,
    title: chunk.title ?? null,
    cleaned_text: chunk.cleanedText ?? '',
    first_word: (chunk.startSnippet || chunk.firstWord || chunk.firstWords || '').split(/\s+/)[0] ?? '',
    last_word: (chunk.endSnippet || chunk.lastWord || chunk.lastWords || '').split(/\s+/).pop() ?? '',
    start_snippet: chunk.startSnippet ?? null,
    end_snippet: chunk.endSnippet ?? null,
  };
}