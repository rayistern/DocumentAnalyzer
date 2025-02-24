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
 * @returns {Promise<{exists: boolean, documentId?: number}>} - Whether document exists and its ID if found
 */
async function checkDocumentHashExists(contentHash) {
    const { data, error } = await supabase
        .from('documents')
        .select('id')
        .eq('content_hash', contentHash)
        .single();

    if (error) {
        if (error.code === 'PGRST116') { // No rows returned
            return { exists: false };
        }
        throw error;
    }

    return { exists: true, documentId: data.id };
}

/**
 * Check if a document is a duplicate and get its ID if it exists
 * @param {string} content - Document content to check
 * @returns {Promise<{isDuplicate: boolean, documentId?: number}>} - Whether document is duplicate and its ID if found
 */
export async function checkDuplicateDocument(content) {
    try {
        const contentHash = calculateContentHash(content);
        const { exists, documentId } = await checkDocumentHashExists(contentHash);
        return { isDuplicate: exists, documentId };
    } catch (error) {
        console.error('Error checking for duplicate document:', error);
        // In case of error, assume document is not a duplicate to ensure processing
        return { isDuplicate: false };
    }
} 