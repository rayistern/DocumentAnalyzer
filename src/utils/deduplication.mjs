import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

/**
 * Calculate SHA-256 hash of document content
 * @param {string} content - Document content to hash
 * @returns {string} - Hex string of the hash
 */
export function calculateContentHash(content) {
    const hash = crypto.createHash('sha256');
    hash.update(content);
    return hash.digest('hex');
}

/**
 * Check if a document with the same content hash exists
 * @param {string} contentHash - Hash of the document content
 * @param {number|null} groupNumber - Optional group number to check within
 * @returns {Promise<{exists: boolean, documentId?: number}>} - Whether document exists and its ID if found
 */
async function checkDocumentHashExists(contentHash, groupNumber = null) {
    let query = supabase
        .from('documents')
        .select('id, document_source_id')
        .eq('content_hash', contentHash)
        .neq('status', 'failed');  // Exclude failed documents from hash check

    if (groupNumber !== null) {
        // Join with document_sources to check group number
        const { data, error } = await supabase
            .from('documents')
            .select('id, document_sources!inner(group_number)')
            .eq('content_hash', contentHash)
            .eq('document_sources.group_number', groupNumber)
            .neq('status', 'failed');

        if (error) {
            throw error;
        }

        if (!data || data.length === 0) {
            return { exists: false };
        }

        return { exists: true, documentId: data[0].id };
    }

    // If no group number specified, check all documents
    const { data, error } = await query;

    if (error) {
        throw error;
    }

    if (!data || data.length === 0) {
        return { exists: false };
    }

    return { exists: true, documentId: data[0].id };
}

/**
 * Check if a document is a duplicate and get its ID if it exists
 * @param {string} content - Document content to check
 * @param {number|null} groupNumber - Optional group number to check within
 * @returns {Promise<{isDuplicate: boolean, documentId?: number}>} - Whether document is duplicate and its ID if found
 */
export async function checkDuplicateDocument(content, groupNumber = null) {
    try {
        const contentHash = calculateContentHash(content);
        const { exists, documentId } = await checkDocumentHashExists(contentHash, groupNumber);
        return { isDuplicate: exists, documentId };
    } catch (error) {
        console.error('Error checking for duplicate document:', error);
        // In case of error, assume document is not a duplicate to ensure processing
        return { isDuplicate: false };
    }
} 