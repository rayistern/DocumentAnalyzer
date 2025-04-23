import { setupProcessTimeout } from '../config.mjs';
import { z } from 'zod';

// Define schemas for validation
/**
 * Zod schema for chunk objects within the response
 * Matches the chunks table structure
 */
export const chunkSchema = z.object({
    startIndex: z.number().int().positive(),
    endIndex: z.number().int().positive(),
    firstWords: z.string().optional(),
    lastWords: z.string().optional(),
    // Additional fields that might be present
    content: z.string().optional(),
    cleanedText: z.string().optional(),
    firstWord: z.string().optional(),
    lastWord: z.string().optional(),
    // In database, warnings is TEXT not array
    warnings: z.union([z.string(), z.array(z.string())]).optional(),
    // Other database fields
    drop_remaining: z.boolean().optional(),
    within_tolerance: z.boolean().optional(),
    position_difference: z.number().optional(),
    llm_suggested_end: z.number().optional(),
    actual_end: z.number().optional(),
    first_word_match: z.boolean().optional(),
    last_word_match: z.boolean().optional(),
    // Metadata is a JSONB field in database
    metadata: z.any().optional(),
    raw_metadata: z.any().optional()
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
 * Based on the structure defined in the chunk_metadata table
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
    bibliography_snippets_jsonb: z.array(
        z.object({
            snippet: z.string(),
            source: z.string()
        })
    ).optional(),
    questions_explicit: z.array(z.string()).optional(),
    questions_implied: z.array(z.string()).optional(),
    reconciled_issues: z.array(z.string()).optional(),
    qa_pair: z.any().optional(), // This is JSONB in the database
    potential_typos: z.array(z.string()).optional(),
    identified_abbreviations: z.array(z.any()).optional(), // This is JSONB[] in the database
    identified_abbreviations_jsonb: z.array(z.any()).optional(), // This is JSONB in the database
    named_entities: z.array(z.string()).optional(),
    novel_approaches: z.array(z.string()).optional()
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

// Also create schema for fullMetadata responses
export const fullMetadataSchema = z.object({
    longDescription: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    questionsAnswered: z.array(z.string()).optional(),
    category: z.string().optional()
}).catchall(z.any());

export function cleanJsonResponse(text) {
    // First, trim all whitespace from the beginning and end
    const trimmedText = text.trim();
    
    // Find the first opening brace and the last closing brace
    const start = trimmedText.indexOf('{');
    const end = trimmedText.lastIndexOf('}') + 1;
    
    if (start === -1 || end === 0) {
        console.log("[HEBREW-HANDLING] No JSON object found in the input");
        return text;
    }

    // Extract just the JSON part
    let jsonText = trimmedText.slice(start, end).trim();
    
    // Log the extracted JSON length for debugging
    console.log(`[HEBREW-HANDLING] Extracted JSON from position ${start} to ${end} (length: ${jsonText.length})`);
    
    // Try to find the most complete and valid JSON object in the text
    let openBraces = 0;
    let insideString = false;
    let isEscaped = false;
    let possibleEndIndex = -1;
    
    for (let i = 0; i < jsonText.length; i++) {
        const char = jsonText[i];
        
        // Handle string boundaries
        if (char === '"' && !isEscaped) {
            insideString = !insideString;
        }
        
        // Track escape characters
        isEscaped = char === '\\' && !isEscaped;
        
        // Only count braces outside of strings
        if (!insideString) {
            if (char === '{') openBraces++;
            else if (char === '}') {
                openBraces--;
                
                // If we've closed all opening braces, this might be the end of a valid JSON object
                if (openBraces === 0) {
                    possibleEndIndex = i + 1;
                    
                    // Test if this is valid JSON
                    try {
                        const testJson = jsonText.substring(0, possibleEndIndex);
                        JSON.parse(testJson);
                        // If we get here, it's valid JSON! We can use this end index
                        break;
                    } catch (e) {
                        // Not valid yet, continue searching
                    }
                }
            }
        }
    }
    
    // If we found a valid end position, use it
    if (possibleEndIndex > 0) {
        console.log(`[HEBREW-HANDLING] Found valid JSON object at character ${possibleEndIndex}`);
        jsonText = jsonText.substring(0, possibleEndIndex);
    } else if (openBraces !== 0) {
        console.log("[HEBREW-HANDLING] Warning: Unbalanced JSON braces detected");
    }
    
    return jsonText;
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
                lastWords,
                // Add database fields with default values
                warnings: "",
                raw_metadata: null,
                firstWord: firstWords.split(' ').slice(0, 2).join(' '),
                lastWord: lastWords.split(' ').slice(-2).join(' '),
                within_tolerance: true,
                position_difference: 0,
                llm_suggested_end: endIndex,
                actual_end: endIndex,
                first_word_match: true,
                last_word_match: true
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
            lastWords: text.substring(Math.max(0, text.length - 30)),
            // Add empty/default values for database fields
            warnings: "", // String in DB, not array
            raw_metadata: null, // JSONB in DB
            cleanedText: text,
            firstWord: text.substring(0, Math.min(10, text.length)),
            lastWord: text.substring(Math.max(0, text.length - 10)),
            // Additional DB fields
            within_tolerance: true,
            position_difference: 0,
            llm_suggested_end: text.length,
            actual_end: text.length,
            first_word_match: true,
            last_word_match: true
        }],
        remainder: false
    };
}

// Update the validateWithZod function to handle the fullMetadata schema
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
        } else if (schemaType === 'fullMetadata') {
            schema = fullMetadataSchema;
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
 * Attempts to repair common JSON syntax errors
 * 
 * @param {string} jsonText - The potentially malformed JSON string
 * @returns {string} - The repaired JSON string
 */
export function repairJson(jsonText) {
    let repairedJson = jsonText;
    
    try {
        // Try parsing as-is first
        JSON.parse(repairedJson);
        return repairedJson; // Already valid
    } catch (error) {
        console.log(`[JSON-REPAIR] Attempting to fix JSON: ${error.message}`);
        
        // Fix 1: Apply control character cleaning again to be safe
        repairedJson = cleanControlCharacters(repairedJson);
        
        // Fix 2: Remove trailing commas in arrays and objects
        repairedJson = repairedJson.replace(/,\s*([\]}])/g, '$1');
        
        // Fix 3: Try to fix unquoted property names
        repairedJson = repairedJson.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
        
        // Fix 4: Attempt to fix the specific qa_pair issue
        // Handle erroneous nesting of fields inside qa_pair
        if (repairedJson.includes('"qa_pair"') && 
            (repairedJson.includes('"potential_typos"') || 
             repairedJson.includes('"identified_abbreviations"') || 
             repairedJson.includes('"named_entities"'))) {
            
            try {
                // First find the "answer" field in qa_pair
                const answerMatch = repairedJson.match(/"answer"\s*:\s*"([^"]*)"/);
                if (answerMatch) {
                    // Find the position after the answer value
                    const posAfterAnswer = repairedJson.indexOf(answerMatch[0]) + answerMatch[0].length;
                    
                    // Check if potential_typos comes after that
                    const afterAnswer = repairedJson.substring(posAfterAnswer);
                    
                    if (afterAnswer.match(/,\s*"(potential_typos|identified_abbreviations|named_entities)"/)) {
                        // Structure is already correct
                        console.log('[JSON-REPAIR] qa_pair structure appears correct');
                    } else if (afterAnswer.match(/"(potential_typos|identified_abbreviations|named_entities)"/)) {
                        // Close qa_pair before these fields
                        const beforeFields = repairedJson.substring(0, posAfterAnswer);
                        const afterFields = repairedJson.substring(posAfterAnswer);
                        
                        repairedJson = beforeFields + '},' + afterFields;
                        console.log('[JSON-REPAIR] Fixed qa_pair structure by adding closing brace');
                    }
                }
            } catch (structureError) {
                console.log(`[JSON-REPAIR] Error fixing qa_pair structure: ${structureError.message}`);
            }
        }
        
        // Fix 5: Try to balance quotes in strings
        let balancedJson = '';
        let inString = false;
        let consecutiveQuotes = 0;
        
        for (let i = 0; i < repairedJson.length; i++) {
            const char = repairedJson[i];
            
            if (char === '"' && (i === 0 || repairedJson[i-1] !== '\\')) {
                inString = !inString;
                consecutiveQuotes++;
            } else {
                if (consecutiveQuotes % 2 !== 0) {
                    // Odd number of quotes, add one to balance
                    balancedJson += '"';
                }
                consecutiveQuotes = 0;
            }
            
            balancedJson += char;
        }
        
        // If we ended inside a string, close it
        if (inString) {
            balancedJson += '"';
        }
        
        try {
            // See if our repairs worked
            JSON.parse(balancedJson);
            console.log('[JSON-REPAIR] Successfully repaired JSON');
            return balancedJson;
        } catch (repairError) {
            console.log(`[JSON-REPAIR] First repair attempt failed: ${repairError.message}`);
            
            // Last resort: Try to extract just the valid part of the JSON
            try {
                // Find the first { and try to extract a complete JSON object
                const startBrace = balancedJson.indexOf('{');
                if (startBrace >= 0) {
                    let openBraces = 1;
                    let validEndPos = -1;
                    
                    for (let i = startBrace + 1; i < balancedJson.length; i++) {
                        const char = balancedJson[i];
                        if (char === '{') openBraces++;
                        else if (char === '}') {
                            openBraces--;
                            if (openBraces === 0) {
                                validEndPos = i + 1;
                                break;
                            }
                        }
                    }
                    
                    if (validEndPos > 0) {
                        const extractedJson = balancedJson.substring(startBrace, validEndPos);
                        try {
                            JSON.parse(extractedJson);
                            console.log('[JSON-REPAIR] Successfully extracted valid JSON subset');
                            return extractedJson;
                        } catch (extractError) {
                            console.log(`[JSON-REPAIR] Failed to extract valid JSON: ${extractError.message}`);
                        }
                    }
                }
            } catch (extractionError) {
                console.log(`[JSON-REPAIR] JSON extraction error: ${extractionError.message}`);
            }
            
            // Return the balanced version as our best effort
            return balancedJson;
        }
    }
}

/**
 * Fixes common structure issues with metadata responses
 * Particularly the issue where fields get incorrectly nested inside qa_pair
 * 
 * @param {Object} parsedObject - The parsed JSON object to fix
 * @returns {Object} - The fixed object with corrected structure
 */
export function fixMetadataStructure(parsedObject) {
    // If there's no qa_pair or it's not an object, nothing to fix
    if (!parsedObject?.qa_pair || typeof parsedObject.qa_pair !== 'object') {
        return parsedObject;
    }

    // Fields that should be at the root level, not inside qa_pair
    const rootLevelFields = [
        'potential_typos',
        'identified_abbreviations', 
        'named_entities',
        'novel_approaches'
    ];
    
    // Check if any of these fields are incorrectly nested inside qa_pair
    const fixedObject = {...parsedObject};
    let modified = false;
    
    rootLevelFields.forEach(field => {
        if (fixedObject.qa_pair[field] !== undefined) {
            console.log(`[METADATA-REPAIR] Moving ${field} from qa_pair to root level`);
            // Move the field to the root level if it doesn't already exist
            if (fixedObject[field] === undefined) {
                fixedObject[field] = fixedObject.qa_pair[field];
                modified = true;
            }
            // Remove it from qa_pair
            delete fixedObject.qa_pair[field];
        }
    });
    
    if (modified) {
        console.log('[METADATA-REPAIR] Fixed qa_pair structure');
    }
    
    return fixedObject;
}

/**
 * Cleanses invalid control characters from JSON string before parsing
 * 
 * @param {string} text - The raw JSON string that might contain control characters
 * @returns {string} - The cleaned JSON string with control characters removed
 */
export function cleanControlCharacters(text) {
    if (!text) return text;
    
    // Step 1: Replace all ASCII control characters (0-31) except tabs, newlines and carriage returns
    let cleanedText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
    
    // Step 2: Handle escaped control characters that might appear as "\u00XX" in the JSON
    cleanedText = cleanedText.replace(/\\u00([01][0-9A-Fa-f])/g, ' ');
    
    // Step 3: Special handling for answer field which often contains problematic content
    // The "answer" field in qa_pair is the most common source of control character errors
    try {
        // First try to find and extract the qa_pair block
        const qaBlockStart = cleanedText.indexOf('"qa_pair"');
        if (qaBlockStart >= 0) {
            // Find the answer field inside the qa_pair
            const answerStart = cleanedText.indexOf('"answer"', qaBlockStart);
            if (answerStart >= 0) {
                // Find the starting quote of the answer value
                const valueStart = cleanedText.indexOf(':', answerStart) + 1;
                const valueQuote = cleanedText.indexOf('"', valueStart);
                
                if (valueQuote >= 0) {
                    // Find the ending quote of the answer
                    let endQuote = -1;
                    let pos = valueQuote + 1;
                    let escaped = false;
                    
                    while (pos < cleanedText.length) {
                        const char = cleanedText[pos];
                        
                        if (char === '\\') {
                            escaped = !escaped;
                        } else if (char === '"' && !escaped) {
                            endQuote = pos;
                            break;
                        } else {
                            escaped = false;
                        }
                        
                        pos++;
                    }
                    
                    if (endQuote > 0) {
                        // Extract the answer content
                        const answerContent = cleanedText.substring(valueQuote + 1, endQuote);
                        
                        // Clean the answer content
                        const cleanedAnswer = answerContent
                            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')         // Control chars
                            .replace(/\\u00([01][0-9A-Fa-f])/g, ' ')                // Escaped control chars  
                            .replace(/\\([^"\\\/bfnrt])/g, '\\\\$1')                // Escape invalid escape sequences
                            .replace(/(?<!\\)"/g, '\\"');                          // Escape any unescaped quotes
                        
                        // Replace the answer in the original text
                        cleanedText = 
                            cleanedText.substring(0, valueQuote + 1) + 
                            cleanedAnswer + 
                            cleanedText.substring(endQuote);
                            
                        console.log("[JSON-CLEAN] Deep cleaned the answer field content");
                    }
                }
            }
        }
    } catch (answerCleanError) {
        console.log("[JSON-CLEAN] Error during deep answer cleaning:", answerCleanError.message);
        // Continue with other cleaning
    }
    
    // Step 4: Fix specific issues with the qa_pair structure if this is a metadata response
    // Only do this if we find a qa_pair field and potential_typos/etc. outside the proper JSON structure
    const qaPattern = /"qa_pair"\s*:\s*{[^}]*"answer"\s*:[^}]*}/;
    const fieldAfterQaPair = /"qa_pair"\s*:\s*{[^}]*}\s*,\s*"(potential_typos|identified_abbreviations|named_entities)"/;
    
    if (qaPattern.test(cleanedText) && !fieldAfterQaPair.test(cleanedText)) {
        // Find problematic pattern where fields are inside qa_pair
        const nestedFieldsPattern = /"qa_pair"\s*:\s*{[^}]*"answer"\s*:[^}]*"(potential_typos|identified_abbreviations|named_entities)"/;
        
        if (nestedFieldsPattern.test(cleanedText)) {
            console.log("[JSON-CLEAN] Detected and fixing nested fields in qa_pair");
            
            // Find the end of the answer field
            const answerEndMatch = cleanedText.match(/"answer"\s*:\s*"((?:\\"|[^"])*)"/);
            if (answerEndMatch) {
                const answerEndPos = cleanedText.indexOf(answerEndMatch[0]) + answerEndMatch[0].length;
                
                // Cut the string at this position and add closing brace for qa_pair
                const beforeFields = cleanedText.substring(0, answerEndPos);
                const afterFields = cleanedText.substring(answerEndPos);
                
                // Close the qa_pair object and continue with potential_typos outside it
                cleanedText = beforeFields + '},' + afterFields.replace(/"\s*,\s*"(potential_typos|identified_abbreviations|named_entities)/, '"$1');
                
                console.log("[JSON-CLEAN] Fixed nested fields structure");
            }
        }
    }
    
    // Step 5: Final specialized handling for well-known error patterns in the JSON response
    if (cleanedText.includes('"answer":') && cleanedText.includes('"potential_typos":')) {
        // Check for missing closing brace in qa_pair
        const problemPattern = /"answer"\s*:\s*"[^"]*"\s*,\s*"potential_typos"/;
        if (problemPattern.test(cleanedText)) {
            console.log("[JSON-CLEAN] Detected missing qa_pair closing brace");
            
            // Add the missing closing brace and comma
            cleanedText = cleanedText.replace(/"answer"\s*:\s*"([^"]*)"\s*,\s*"potential_typos"/, '"answer": "$1"},"potential_typos"');
            console.log("[JSON-CLEAN] Added missing closing brace for qa_pair");
        }
    }
    
    if (cleanedText !== text) {
        console.log("[JSON-CLEAN] Cleaned problematic characters or structure in JSON string");
    }
    
    return cleanedText;
}

/**
 * Parses LLM JSON responses with multiple fallback strategies
 * 
 * IMPORTANT: Parameter order matters! Common source of bugs:
 * 1. jsonResponseText - The raw LLM response to parse (required)
 * 2. cleanedText - The text sent to the LLM (for fallbacks, can be null)
 * 3. schemaType - The expected schema type ('chunk', 'metadata', etc.)
 * 
 * Common issues:
 * - Missing cleanedText parameter causes schemaType to be treated as cleanedText
 * - This results in incorrect fallback behavior (chunk instead of metadata)
 * - Always pass null as second param when text extraction isn't needed
 * 
 * Workflow for each schema type:
 * - chunk: Requires cleanedText for fallback text extraction
 * - metadata/fullMetadata: Does not use cleanedText (pass null)
 * - summarize/sentiment: Does not use cleanedText (pass null)
 * 
 * Multiple parsing strategies:
 * 1. Standard JSON.parse with Zod validation
 * 2. Extract JSON from markdown and parse with Zod
 * 3. Schema-specific string-based extraction for chunks
 * 4. Schema-specific fallbacks (chunk vs. metadata)
 * 
 * @param {string} jsonResponseText - The response text from the LLM
 * @param {string|null} cleanedText - The cleaned input text sent to the LLM (null if not needed)
 * @param {string} schemaType - The type of schema to use ('chunk', 'metadata', 'fullMetadata', etc.)
 * @returns {Object} Parsed response object according to the specified schema type
 */
export function parseJsonResponse(jsonResponseText, cleanedText = null, schemaType = 'chunk') {
    // First clean any control characters that would break JSON parsing
    const sanitizedJson = cleanControlCharacters(jsonResponseText);
    
    // First attempt: Try standard JSON.parse with Zod validation
    try {
        const parsed = JSON.parse(sanitizedJson);
        
        // Fix metadata structure if applicable
        const fixedParsed = schemaType === 'metadata' ? fixMetadataStructure(parsed) : parsed;
        
        // Validate with Zod
        const validated = validateWithZod(fixedParsed, schemaType);
        if (validated) {
            console.log("[HEBREW-HANDLING] Successfully parsed and validated response with Zod");
            return validated;
        }
        
        // If Zod validation fails but JSON parsing worked, still return the parsed JSON
        console.log("[HEBREW-HANDLING] JSON parsing succeeded but Zod validation failed. Using parsed data anyway.");
        return fixedParsed;
    } catch (error) {
        console.log("[HEBREW-HANDLING] Standard JSON parsing failed:", error.message);
    }
    
    // Second attempt: Extract JSON part and try to parse with Zod
    try {
        const extractedJson = cleanJsonResponse(sanitizedJson);
        if (extractedJson) {
            try {
                const parsed = JSON.parse(extractedJson);
                
                // Fix metadata structure if applicable
                const fixedParsed = schemaType === 'metadata' ? fixMetadataStructure(parsed) : parsed;
                
                // Validate with Zod
                const validated = validateWithZod(fixedParsed, schemaType);
                if (validated) {
                    console.log("[HEBREW-HANDLING] Successfully parsed and validated extracted JSON with Zod");
                    return validated;
                }
                
                // If Zod validation fails but JSON parsing worked, return the parsed JSON
                console.log("[HEBREW-HANDLING] Extracted JSON parsing succeeded but Zod validation failed. Using parsed data anyway.");
                return fixedParsed;
            } catch (parseError) {
                // Try repairing the JSON
                console.log("[HEBREW-HANDLING] Attempting to repair extracted JSON");
                const repairedJson = repairJson(extractedJson);
                
                try {
                    const parsed = JSON.parse(repairedJson);
                    console.log("[HEBREW-HANDLING] Successfully parsed repaired JSON");
                    
                    // Fix metadata structure if applicable
                    const fixedParsed = schemaType === 'metadata' ? fixMetadataStructure(parsed) : parsed;
                    
                    // Validate with Zod
                    const validated = validateWithZod(fixedParsed, schemaType);
                    if (validated) {
                        console.log("[HEBREW-HANDLING] Successfully validated repaired JSON with Zod");
                        return validated;
                    }
                    
                    // If Zod validation fails but JSON parsing worked, return the parsed JSON
                    console.log("[HEBREW-HANDLING] Repaired JSON parsing succeeded but Zod validation failed. Using parsed data anyway.");
                    return fixedParsed;
                } catch (repairError) {
                    console.log("[HEBREW-HANDLING] Repair attempt failed:", repairError.message);
                }
            }
        }
    } catch (error) {
        console.log("[HEBREW-HANDLING] Extracted JSON parsing failed:", error.message);
    }
    
    // Third attempt: Fallback to string-based extraction
    if (schemaType === 'chunk') {
        console.log("[HEBREW-HANDLING] Attempting string-based chunk extraction");
        const extractedChunks = extractChunksFromString(sanitizedJson);
        
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
    } else if (schemaType === 'metadata' || schemaType === 'fullMetadata') {
        // For metadata, try aggressive recovery with regex extraction
        console.log(`[HEBREW-HANDLING] Attempting aggressive metadata extraction for ${schemaType}`);
        
        try {
            // More aggressive JSON recovery for metadata fields
            const recoveredMetadata = {};
            
            // Define patterns for each key field type
            const stringFieldPatterns = [
                { field: 'long_summary', pattern: /"long_summary"\s*:\s*"((?:\\"|[^"])*)"/i },
                { field: 'short_summary', pattern: /"short_summary"\s*:\s*"((?:\\"|[^"])*)"/i },
                { field: 'generated_title', pattern: /"generated_title"\s*:\s*"((?:\\"|[^"])*)"/i }
            ];
            
            // Try to extract the string fields
            stringFieldPatterns.forEach(({field, pattern}) => {
                const match = sanitizedJson.match(pattern);
                if (match && match[1]) {
                    recoveredMetadata[field] = match[1].replace(/\\"/g, '"');
                    console.log(`[HEBREW-HANDLING] Recovered ${field} field through regex`);
                }
            });
            
            // Array fields follow a pattern like "field": ["item1", "item2"]
            const arrayFieldPatterns = [
                { field: 'quiz_questions', pattern: /"quiz_questions"\s*:\s*\[(.*?)\]/is },
                { field: 'followup_thinking_questions', pattern: /"followup_thinking_questions"\s*:\s*\[(.*?)\]/is },
                { field: 'tags_he', pattern: /"tags_he"\s*:\s*\[(.*?)\]/is },
                { field: 'key_terms_he', pattern: /"key_terms_he"\s*:\s*\[(.*?)\]/is },
                // Add missing array fields
                { field: 'key_phrases_he', pattern: /"key_phrases_he"\s*:\s*\[(.*?)\]/is },
                { field: 'key_phrases_en', pattern: /"key_phrases_en"\s*:\s*\[(.*?)\]/is },
                { field: 'questions_implied', pattern: /"questions_implied"\s*:\s*\[(.*?)\]/is },
                { field: 'potential_typos', pattern: /"potential_typos"\s*:\s*\[(.*?)\]/is },
                { field: 'named_entities', pattern: /"named_entities"\s*:\s*\[(.*?)\]/is }
            ];
            
            // Extract array fields
            arrayFieldPatterns.forEach(({field, pattern}) => {
                const match = sanitizedJson.match(pattern);
                if (match && match[1]) {
                    try {
                        // Convert the array content to proper JSON
                        const arrayContent = `[${match[1]}]`;
                        const fixedArray = arrayContent
                            .replace(/'/g, '"')  // Replace single quotes with double quotes
                            .replace(/",\s*]/g, '"]'); // Fix trailing commas
                            
                        recoveredMetadata[field] = JSON.parse(fixedArray);
                        console.log(`[HEBREW-HANDLING] Recovered ${field} array through regex`);
                    } catch (arrayError) {
                        console.log(`[HEBREW-HANDLING] Could not parse ${field} array: ${arrayError.message}`);
                        // Create a basic array with the content as a single item
                        recoveredMetadata[field] = [match[1].replace(/"/g, '').trim()];
                    }
                }
            });
            
            // Special handling for complex objects like bibliography_snippets and identified_abbreviations
            try {
                // Try to extract bibliography_snippets
                const bibliographyMatch = sanitizedJson.match(/"bibliography_snippets"\s*:\s*\[(.*?)\]/is);
                if (bibliographyMatch && bibliographyMatch[1]) {
                    try {
                        // Create a valid JSON array
                        const jsonStr = `[${bibliographyMatch[1]}]`;
                        const parsed = JSON.parse(jsonStr);
                        recoveredMetadata.bibliography_snippets = parsed;
                        // Also add as bibliography_snippets_jsonb since they're the same
                        recoveredMetadata.bibliography_snippets_jsonb = parsed;
                        console.log(`[HEBREW-HANDLING] Recovered bibliography_snippets through regex`);
                    } catch (e) {
                        console.log(`[HEBREW-HANDLING] Could not parse bibliography_snippets: ${e.message}`);
                    }
                }
                
                // Try to extract identified_abbreviations
                const abbreviationsMatch = sanitizedJson.match(/"identified_abbreviations"\s*:\s*\[(.*?)\]/is);
                if (abbreviationsMatch && abbreviationsMatch[1]) {
                    try {
                        // Create a valid JSON array
                        const jsonStr = `[${abbreviationsMatch[1]}]`;
                        const parsed = JSON.parse(jsonStr);
                        recoveredMetadata.identified_abbreviations = parsed;
                        // Also add as identified_abbreviations_jsonb since they're the same
                        recoveredMetadata.identified_abbreviations_jsonb = parsed;
                        console.log(`[HEBREW-HANDLING] Recovered identified_abbreviations through regex`);
                    } catch (e) {
                        console.log(`[HEBREW-HANDLING] Could not parse identified_abbreviations: ${e.message}`);
                    }
                }
            } catch (complexObjectError) {
                console.log(`[HEBREW-HANDLING] Error handling complex objects: ${complexObjectError.message}`);
            }
            
            // Try to extract qa_pair as a special case
            const questionMatch = sanitizedJson.match(/"question"\s*:\s*"((?:\\"|[^"])*)"/i);
            const answerMatch = sanitizedJson.match(/"answer"\s*:\s*"((?:\\"|[^"])*)"/i);
            
            if (questionMatch && questionMatch[1] && answerMatch && answerMatch[1]) {
                recoveredMetadata.qa_pair = {
                    question: questionMatch[1].replace(/\\"/g, '"'),
                    answer: answerMatch[1].replace(/\\"/g, '"')
                };
                console.log(`[HEBREW-HANDLING] Recovered qa_pair through regex`);
            }
            
            // If we recovered any fields, try to construct a valid JSON object and validate with Zod
            const recoveredFields = Object.keys(recoveredMetadata);
            if (recoveredFields.length > 0) {
                console.log(`[HEBREW-HANDLING] Successfully recovered ${recoveredFields.length} metadata fields through aggressive extraction`);
                console.log(`[HEBREW-HANDLING] Recovered fields: ${recoveredFields.join(', ')}`);
                
                // Try to validate our constructed metadata with Zod
                try {
                    // First fix metadata structure if applicable
                    const fixedMetadata = schemaType === 'metadata' ? fixMetadataStructure(recoveredMetadata) : recoveredMetadata;
                    
                    // Validate with Zod
                    const validated = validateWithZod(fixedMetadata, schemaType);
                    if (validated) {
                        console.log("[HEBREW-HANDLING] Successfully validated regex-extracted metadata with Zod");
                        return validated;
                    }
                } catch (zodError) {
                    console.log(`[HEBREW-HANDLING] Regex-extracted metadata validation failed: ${zodError.message}`);
                }
                
                // If validation fails or errors, still return the recovered metadata
                return recoveredMetadata;
            }
        } catch (aggressiveRecoveryError) {
            console.log(`[HEBREW-HANDLING] Aggressive metadata recovery failed: ${aggressiveRecoveryError.message}`);
        }
        
        // One final attempt - try cleaning and parsing again
        try {
            // Attempt one more clean parse
            const cleanedJson = cleanJsonResponse(sanitizedJson);
            const parsedMetadata = JSON.parse(cleanedJson || sanitizedJson);
            
            // Verify this is actually a metadata object and not a chunks object
            if (parsedMetadata.chunks) {
                console.log(`[HEBREW-HANDLING] Warning: Parsed ${schemaType} response contains 'chunks' field, which suggests incorrect structure`);
                // Return a minimal metadata structure
                return {
                    long_summary: "Response contained chunks instead of metadata",
                    short_summary: "Incorrect response structure",
                    generated_title: "Metadata Structure Error"
                };
            }
            
            // Fix metadata structure if applicable
            if (schemaType === 'metadata') {
                const fixedMetadata = fixMetadataStructure(parsedMetadata);
                
                // Try Zod validation one more time
                try {
                    const validated = validateWithZod(fixedMetadata, schemaType);
                    if (validated) {
                        console.log(`[HEBREW-HANDLING] Successfully validated final attempt ${schemaType} with Zod`);
                        return validated;
                    }
                } catch (finalZodError) {
                    console.log(`[HEBREW-HANDLING] Final Zod validation failed: ${finalZodError.message}`);
                }
                
                console.log(`[HEBREW-HANDLING] Applied structure fixes to ${schemaType} response`);
                return fixedMetadata;
            }
            
            return parsedMetadata;
        } catch (error) {
            console.log(`[HEBREW-HANDLING] Final JSON parsing attempt failed for ${schemaType}:`, error.message);
            // Return a minimal metadata object to avoid null errors
            return {
                long_summary: `Failed to parse ${schemaType} response: ${error.message}`,
                short_summary: "JSON parsing error",
                generated_title: "Metadata Parsing Error"
            };
        }
    }
    
    // Final fallback: Create appropriate empty object based on schema type
    if (schemaType === 'chunk') {
        console.log("[HEBREW-HANDLING] All parsing attempts failed. Creating single document chunk.");
        return createSingleDocumentChunk(cleanedText);
    } else if (schemaType === 'metadata' || schemaType === 'fullMetadata') {
        console.log(`[HEBREW-HANDLING] All parsing attempts failed. Creating empty ${schemaType} object.`);
        // Return empty metadata object with minimum required structure
        return {
            long_summary: "Failed to parse metadata response",
            short_summary: "Parsing error",
            generated_title: "Metadata Parsing Error"
        };
    } else {
        console.log(`[HEBREW-HANDLING] All parsing attempts failed. Creating empty object for ${schemaType}.`);
        return {};
    }
} 