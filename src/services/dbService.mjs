import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

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

export async function checkDocumentExists(filename) {
    // Construct the full path with backslashes
    const fullPath = `G:\\My Drive\\Igros\\${filename}`;
    console.log('Checking document with full path:', fullPath);
    
    const { data, error } = await supabase
        .from('document_sources')
        .select('id, filename')
        .eq('filename', fullPath);
    
    if (error) {
        console.error('Error checking document:', error);
        return false;
    }
    
    // Also check without path
    if (!data?.length) {
        const { data: simpleData, error: simpleError } = await supabase
            .from('document_sources')
            .select('id, filename')
            .eq('filename', filename);
            
        if (simpleData?.length) {
            return true;
        }
    }
    
    return data && data.length > 0;
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
    
    return data?.[0] || null;
} 