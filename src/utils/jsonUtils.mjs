import { setupProcessTimeout } from '../config.mjs';
import { z } from 'zod';

// Define schemas for validation
/**
 * Zod schema for chunk objects within the response
 */
export const chunkSchema = z.object({
    startIndex: z.number().int().positive(),
    endIndex: z.number().int().positive(),
    firstWords: z.string().optional(),
    lastWords: z.string().optional()
}).refine(data => data.endIndex >= data.startIndex, {
    message: "endIndex must be greater than or equal to startIndex",
    path: ["endIndex"]
});

/**
 * Zod schema for the entire chunk response
 */
export const chunkResponseSchema = z.object({
    chunks: z.array(chunkSchema),
    remainder: z.boolean().optional()
});

/**
 * Zod schema for text removal objects
 */
export const textRemovalSchema = z.object({
    textToRemove: z.array(z.object({
        text: z.string(),
        startPosition: z.number().int().positive(),
        endPosition: z.number().int().positive(),
        contextBefore: z.string().optional(),
        contextAfter: z.string().optional()
    }))
});

// Replace the generic metadata schema with a more specific one
/**
 * Zod schema for metadata responses
 * Based on the structure defined in OPENAI_PROMPTS.metadata in settings.mjs
 */
export const metadataSchema = z.object({
    long_summary: z.string().optional(),
    short_summary: z.string().optional(),
    quiz_questions: z.array(z.string()).optional(),
    followup_thinking_questions: z.array(z.string()).optional(),
    generated_title: z.string().optional(),
    tags_he: z.array(z.string()).optional(),
    key_terms_he: z.array(z.string()).optional(),
    key_phrases_he: z.array(z.string()).optional(),
    key_phrases_en: z.array(z.string()).optional(),
    bibliography_snippets: z.array(
        z.object({
            snippet: z.string(),
            source: z.string()
        })
    ).optional(),
    questions_explicit: z.array(z.string()).optional(),
    questions_implied: z.array(z.string()).optional(),
    qa_pair: z.array(z.string()).optional(),
    potential_typos: z.array(z.string()).optional(),
    identified_abbreviations: z.array(z.string()).optional(),
    named_entities: z.array(z.string()).optional()
}).catchall(z.any()); // Still allow any extra fields for flexibility

// Also create a schema for summarize responses
export const summarizeSchema = z.object({
    summary: z.string(),
    keyPoints: z.array(z.string()).optional()
}).catchall(z.any());

// And a schema for sentiment responses
export const sentimentSchema = z.object({
    sentiment: z.enum(["positive", "negative", "neutral"]),
    score: z.number().min(1).max(5),
    confidence: z.number().min(0).max(1)
}).catchall(z.any());

export function cleanJsonResponse(text) {
    // Find the actual JSON content
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    if (start === -1 || end === 0) return text;


// Set up the global timeout for all processes
setupProcessTimeout();

    
    return text.slice(start, end);
}

/**
 * Extracts chunks from a string representation of JSON when standard parsing fails.
 * 
 * This function is specifically designed to handle cases where Hebrew text with
 * embedded quotes causes JSON.parse() to fail. It uses regex patterns to extract
 * chunk objects and their properties from a string representation of JSON.
 * 
 * @param {string} jsonText - The string representation of JSON to extract chunks from
 * @returns {Object} An object containing the extracted chunks and remainder flag
 */
export function extractChunksFromString(jsonText) {
    console.log("[HEBREW-HANDLING] Attempting to extract chunks via string-based approach");
    const chunks = [];
    
    // Match chunk objects in the string
    const chunkRegex = /{[^{}]*?"startIndex"[^{}]+?"endIndex"[^{}]+?}/g;
    const chunkMatches = jsonText.match(chunkRegex) || [];
    
    // Process each matched chunk
    chunkMatches.forEach(chunkStr => {
        // Extract startIndex
        let startIndexMatch = chunkStr.match(/"startIndex"\s*:\s*(\d+)/);
        let startIndex = startIndexMatch ? parseInt(startIndexMatch[1]) : null;
        
        // Extract endIndex
        let endIndexMatch = chunkStr.match(/"endIndex"\s*:\s*(\d+)/);
        let endIndex = endIndexMatch ? parseInt(endIndexMatch[1]) : null;

        // Extract firstWords if available
        let firstWordsMatch = chunkStr.match(/"firstWords"\s*:\s*"([^"]*)"/);
        let firstWords = firstWordsMatch ? firstWordsMatch[1] : '';

        // Extract lastWords if available
        let lastWordsMatch = chunkStr.match(/"lastWords"\s*:\s*"([^"]*)"/);
        let lastWords = lastWordsMatch ? lastWordsMatch[1] : '';
        
        if (startIndex !== null && endIndex !== null) {
            chunks.push({
                startIndex,
                endIndex,
                firstWords,
                lastWords
            });
        }
    });
    
    // Extract remainder flag if present
    let remainderMatch = jsonText.match(/"remainder"\s*:\s*(true|false)/);
    let remainder = remainderMatch ? (remainderMatch[1] === 'true') : undefined;
    
    if (remainder !== undefined) {
        console.log(`[HEBREW-HANDLING] Extracted remainder flag: ${remainder}`);
    }
    
    return { 
        chunks,
        remainder
    };
}

/**
 * Creates a single document chunk as a fallback when all parsing methods fail.
 * 
 * @param {string} text - The full document text
 * @returns {Object} An object containing a single chunk spanning the entire document
 */
export function createSingleDocumentChunk(text) {
    console.log("[HEBREW-HANDLING] Creating single document chunk as fallback");
    return {
        chunks: [{
            startIndex: 1,
            endIndex: text.length,
            content: text,
            firstWords: text.substring(0, Math.min(30, text.length)),
            lastWords: text.substring(Math.max(0, text.length - 30))
        }]
    };
}

// Update the validateWithZod function to handle the new schema types
export function validateWithZod(data, schemaType = 'chunk') {
    try {
        let schema;
        
        // Select the appropriate schema based on the data structure
        if (schemaType === 'chunk') {
            schema = chunkResponseSchema;
        } else if (schemaType === 'textRemoval') {
            schema = textRemovalSchema;
        } else if (schemaType === 'metadata') {
            schema = metadataSchema;
        } else if (schemaType === 'summarize') {
            schema = summarizeSchema;
        } else if (schemaType === 'sentiment') {
            schema = sentimentSchema;
        } else {
            console.warn(`[ZOD] Unknown schema type: ${schemaType}`);
            return null;
        }
        
        // Validate the data against the schema
        const validatedData = schema.parse(data);
        console.log(`[ZOD] Successfully validated ${schemaType} data`);
        return validatedData;
    } catch (error) {
        console.warn(`[ZOD] Validation failed for ${schemaType} data:`, error.message);
        if (error.errors) {
            console.warn(`[ZOD] Validation errors:`, error.errors);
        }
        return null;
    }
}

/**
 * Parses JSON response from LLM with enhanced handling for Hebrew text.
 * 
 * This function implements a multi-layered fallback approach to handle
 * Hebrew text with embedded quotes that can break standard JSON parsing:
 * 
 * 1. Attempts standard JSON.parse with Zod validation
 * 2. If that fails, tries to extract just the JSON part from the response
 * 3. If that fails, falls back to regex-based string extraction
 * 4. If all parsing attempts fail, creates a single chunk for the entire text
 * 
 * @param {string} jsonResponseText - The response text from the LLM
 * @param {string} cleanedText - The cleaned input text sent to the LLM
 * @param {string} schemaType - The type of schema to use ('chunk' or 'textRemoval')
 * @returns {Object} Parsed response with chunks
 */
export function parseJsonResponse(jsonResponseText, cleanedText, schemaType = 'chunk') {
    let parsedResponse;
    
    // First attempt: Try standard JSON.parse with Zod validation
    try {
        const parsed = JSON.parse(jsonResponseText);
        
        // Validate with Zod
        const validated = validateWithZod(parsed, schemaType);
        if (validated) {
            console.log("[HEBREW-HANDLING] Successfully parsed and validated response with Zod");
            return validated;
        }
        
        // If Zod validation fails but JSON parsing worked, still return the parsed JSON
        console.log("[HEBREW-HANDLING] JSON parsing succeeded but Zod validation failed. Using parsed data anyway.");
        return parsed;
    } catch (error) {
        console.log("[HEBREW-HANDLING] Standard JSON parsing failed:", error.message);
    }
    
    // Second attempt: Extract JSON part and try to parse with Zod
    try {
        const extractedJson = cleanJsonResponse(jsonResponseText);
        if (extractedJson) {
            const parsed = JSON.parse(extractedJson);
            
            // Validate with Zod
            const validated = validateWithZod(parsed, schemaType);
            if (validated) {
                console.log("[HEBREW-HANDLING] Successfully parsed and validated extracted JSON with Zod");
                return validated;
            }
            
            // If Zod validation fails but JSON parsing worked, return the parsed JSON
            console.log("[HEBREW-HANDLING] Extracted JSON parsing succeeded but Zod validation failed. Using parsed data anyway.");
            return parsed;
        }
    } catch (error) {
        console.log("[HEBREW-HANDLING] Extracted JSON parsing failed:", error.message);
    }
    
    // Third attempt: Fallback to string-based extraction
    console.log("[HEBREW-HANDLING] Attempting string-based chunk extraction");
    if (schemaType === 'chunk') {
        const extractedChunks = extractChunksFromString(jsonResponseText);
        
        if (extractedChunks.chunks && extractedChunks.chunks.length > 0) {
            console.log(`[HEBREW-HANDLING] Successfully extracted ${extractedChunks.chunks.length} chunks using string-based approach`);
            
            // Try to validate the extracted chunks
            const validated = validateWithZod(extractedChunks, 'chunk');
            if (validated) {
                console.log("[HEBREW-HANDLING] Successfully validated string-extracted chunks with Zod");
                return validated;
            }
            
            // If validation fails, still return the extracted chunks
            return extractedChunks;
        }
    }
    
    // Final fallback: Create a single document chunk
    console.log("[HEBREW-HANDLING] All parsing attempts failed. Creating single document chunk.");
    return createSingleDocumentChunk(cleanedText);
} 