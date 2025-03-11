import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import path from 'path';
import { setupProcessTimeout } from '../config.mjs';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Set up the global timeout for all processes
setupProcessTimeout();

async function debugCheckFilename(filename) {
    // Check for any similar filenames
    const { data, error } = await supabase
        .from('document_sources')
        .select('filename')
        .ilike('filename', '%' + filename + '%');
    
    console.log('Debug - Found these similar filenames in DB:', data);
}

export async function checkDocumentExists(filename, reprocessIncomplete = false, groupNumber = null) {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] 🔍 CHECKING DOCUMENT EXISTS: ${filename}`);
    console.log(`[${timestamp}] Group number: ${groupNumber || 'none'}`);
    console.log(`[${timestamp}] Reprocess incomplete: ${reprocessIncomplete}`);
    
    // Extract just the filename without path if it contains path separators
    const baseFilename = filename.includes('/') || filename.includes('\\') 
        ? path.basename(filename) 
        : filename;
    
    console.log(`[${timestamp}] Base filename: ${baseFilename}`);
    
    // Construct the full path with backslashes
    const fullPath = `G:\\My Drive\\Igros\\${baseFilename}`;
    console.log(`[${timestamp}] Checking with full path: ${fullPath}`);
    
    // Log all possible name variations for debugging
    const possibleNames = [
        baseFilename,
        fullPath,
        `G:/My Drive/Igros/${baseFilename}`,
        baseFilename.replace(/\\/g, '/'),
        baseFilename.replace(/\//g, '\\')
    ];
    console.log(`[${timestamp}] Checking with possible name variations:`, possibleNames);
    
    // Check for any recent entries (last 5 minutes) with this filename in any group
    // This helps detect if another process is currently working on this file
    console.log(`[${timestamp}] Checking for recent activity with this file...`);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentData, error: recentError } = await supabase
        .from('document_sources')
        .select('id, filename, status, group_number, created_at')
        .or(`filename.eq.${baseFilename},filename.eq.${fullPath},filename.ilike.%${baseFilename}`)
        .gt('created_at', fiveMinutesAgo);
        
    if (!recentError && recentData?.length) {
        console.log(`[${timestamp}] ⚠️ Found ${recentData.length} recent entries for this file (created in last 5 minutes):`);
        recentData.forEach((doc, i) => {
            console.log(`[${timestamp}]   ${i+1}. Filename: ${doc.filename} | Status: ${doc.status} | Group: ${doc.group_number || 'none'} | Created: ${doc.created_at}`);
        });
        console.log(`[${timestamp}] ❌ File appears to be currently processing in another session - skipping to prevent conflicts`);
        return true; // Treat as existing to prevent concurrent processing
    }
    
    // First check: exact match with group filter
    let query = supabase
        .from('document_sources')
        .select('id, filename, status, group_number');

    // If group number is provided, only check within that group
    if (groupNumber !== null) {
        query = query.eq('group_number', groupNumber);
        console.log(`[${timestamp}] Filtering by group: ${groupNumber}`);
    }
    
    // Use OR for different filename formats
    query = query.or(`filename.eq.${baseFilename},filename.eq.${fullPath},filename.ilike.%${baseFilename}`);
    
    console.log(`[${timestamp}] Executing primary query...`);
    const { data, error } = await query;
    
    if (error) {
        console.error(`[${timestamp}] ❌ Error checking document:`, error);
        return false;
    }
    
    if (data?.length) {
        console.log(`[${timestamp}] ✅ Found ${data.length} matching documents:`);
        data.forEach((doc, i) => {
            console.log(`[${timestamp}]   ${i+1}. Filename: ${doc.filename} | Status: ${doc.status} | Group: ${doc.group_number || 'none'}`);
        });
        
        // If document exists but is in 'processing' status and reprocessIncomplete is true, allow reprocessing
        const matchingDoc = data[0];
        if (reprocessIncomplete && matchingDoc.status === 'processing') {
            console.log(`[${timestamp}] Document is in 'processing' status - will reprocess`);
            return false;
        }
        
        // Consider document as existing unless it's failed
        const exists = matchingDoc.status !== 'failed';
        console.log(`[${timestamp}] Document exists (not failed): ${exists}`);
        return exists;
    }
    
    // Second check: if no group was specified or no match found with group, check for any group
    if (groupNumber !== null) {
        console.log(`[${timestamp}] No match with group filter, checking in any group...`);
        const { data: anyGroupData, error: anyGroupError } = await supabase
            .from('document_sources')
            .select('id, filename, status, group_number')
            .or(`filename.eq.${baseFilename},filename.eq.${fullPath},filename.ilike.%${baseFilename}`);
            
        if (!anyGroupError && anyGroupData?.length) {
            console.log(`[${timestamp}] ⚠️ Found document in different groups:`);
            anyGroupData.forEach((doc, i) => {
                console.log(`[${timestamp}]   ${i+1}. Filename: ${doc.filename} | Status: ${doc.status} | Group: ${doc.group_number || 'none'}`);
            });
            console.log(`[${timestamp}] ✅ Document exists in other groups but not in group ${groupNumber} - will process`);
            // Return false to allow processing when document exists but not in the specified group
            return false;
        }
    }
    
    console.log(`[${timestamp}] ❌ Document not found in document_sources`);
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