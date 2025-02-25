import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import path from 'path';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

async function debugCheckFilename(filename) {
    // Check for any similar filenames
    const { data, error } = await supabase
        .from('document_sources')
        .select('filename')
        .ilike('filename', '%' + filename + '%');
    
    console.log('Debug - Found these similar filenames in DB:', data);
}

export async function checkDocumentExists(filename, reprocessIncomplete = false, groupNumber = null) {
    // Construct the full path with backslashes
    const fullPath = `G:\\My Drive\\Igros\\${filename}`;
    console.log('Checking document with full path:', fullPath);
    
    let query = supabase
        .from('document_sources')
        .select('id, filename, status');

    // If group number is provided, only check within that group
    if (groupNumber !== null) {
        query = query.eq('group_number', groupNumber);
    }
    query = query.eq('filename', fullPath);
    
    const { data, error } = await query;
    
    if (error) {
        console.error('Error checking document:', error);
        return false;
    }
    
    // Also check without path if not found with full path
    if (!data?.length) {
        let simpleQuery = supabase
            .from('document_sources')
            .select('id, filename, status');
            
        // Apply group filter here too
        if (groupNumber !== null) {
            simpleQuery = simpleQuery.eq('group_number', groupNumber);
        }
        simpleQuery = simpleQuery.eq('filename', filename);
        
        const { data: simpleData, error: simpleError } = await simpleQuery;
            
        if (simpleData?.length) {
            // If document exists but is in 'processing' status and reprocessIncomplete is true, allow reprocessing
            if (reprocessIncomplete && simpleData[0].status === 'processing') {
                console.log(`Found document in 'processing' status - will reprocess`);
                return false;
            }
            // Consider document as existing unless it's failed
            return simpleData[0].status !== 'failed';
        }
    }
    
    // Same logic for full path matches
    if (data?.length) {
        if (reprocessIncomplete && data[0].status === 'processing') {
            console.log(`Found document in 'processing' status - will reprocess`);
            return false;
        }
        return data[0].status !== 'failed';
    }
    
    return false;
}

export async function getLastProcessedDocument() {
    const { data, error } = await supabase
        .from('document_sources')
        .select('id, filename')
        .eq('status', 'processed')
        .order('created_at', { ascending: false })
        .limit(1);
    
    if (error) {
        console.error('Error getting last processed document:', error);
        return null;
    }
    
    // Return just the filename without path
    return data?.[0] ? {
        ...data[0],
        filename: path.basename(data[0].filename)
    } : null;
} 