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
    console.log('\n=== DUPLICATE CHECK ===');
    console.log('Looking for hash:', contentHash);
    const { data, error } = await supabase
        .from('documents')
        .select('id, content_hash, status, original_filename')
        .eq('content_hash', contentHash)
        .neq('status', 'failed');  // Exclude failed documents from hash check

    if (error) {
        if (error.code === 'PGRST116') {
            console.log('❌ No matching document found (PGRST116)');
            return { exists: false };
        }
        console.error('❌ Error checking hash:', error);
        throw error;
    }

    if (!data || data.length === 0) {
        console.log('❌ No matching document found (empty result)');
        return { exists: false };
    }

    console.log('✅ Found matching documents:', data.length);
    data.forEach(doc => {
        console.log(`  - Document ID: ${doc.id}`);
        console.log(`    File: ${doc.original_filename}`);
        console.log(`    Status: ${doc.status}`);
        console.log(`    Hash: ${doc.content_hash}`);
    });
    return { exists: true, documentId: data[0].id };
}

/**
 * Check if a document is a duplicate and get its ID if it exists
 * @param {string} content - Document content to check
 * @returns {Promise<{isDuplicate: boolean, documentId?: number}>} - Whether document is duplicate and its ID if found
 */
export async function checkDuplicateDocument(content) {
    try {
        console.log('\n=== DOCUMENT HASH GENERATION ===');
        const contentHash = calculateContentHash(content);
        console.log('Generated hash:', contentHash);
        console.log('Content preview:');
        console.log('- Length:', content.length);
        console.log('- First 100 chars:', content.substring(0, 100));
        console.log('- Last 100 chars:', content.substring(content.length - 100));
        
        const { exists, documentId } = await checkDocumentHashExists(contentHash);
        console.log('\n=== FINAL RESULT ===');
        console.log('Is duplicate:', exists);
        console.log('Matching document ID:', documentId || 'none');
        return { isDuplicate: exists, documentId };
    } catch (error) {
        console.error('Error checking for duplicate document:', error);
        return { isDuplicate: false };
    }
} 