import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

export async function checkDocumentExists(filename) {
    console.log('Checking document:', filename);
    
    // Try exact match first
    let { data, error } = await supabase
        .from('document_sources')
        .select('id, filename')
        .eq('filename', filename);
    
    if (error) {
        console.error('Error checking document:', error);
        return false;
    }
    
    // If no exact match, try case-insensitive match
    if (!data?.length) {
        ({ data, error } = await supabase
            .from('document_sources')
            .select('id, filename')
            .ilike('filename', filename));
            
        if (error) {
            console.error('Error checking document:', error);
            return false;
        }
    }
    
    console.log('Database results:', data);
    return data?.length > 0;
} 