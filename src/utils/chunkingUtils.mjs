const logger = globalThis.logger || {
  debug: (...args) => console.debug('[DEBUG]', ...args),
  info: (...args) => console.info('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

// ---------------------------------------------------------------------------
//  SNIPPET-BASED EXTRACTION  (new helper)
// ---------------------------------------------------------------------------
/**
 * Extracts a chunk of text between a start and end snippet.
 * Prioritizes direct matches of snippets in the text.
 * Falls back to matching normalized versions of snippets if direct matches fail.
 * All operations and returned slices are based on the original input 'text'.
 *
 * @param {object} params - The parameters object.
 * @param {string} params.text - The original text to search within.
 * @param {string} params.startSnippet - The snippet marking the beginning of the chunk.
 * @param {string} [params.endSnippet] - The snippet marking the end of the chunk (optional).
 * @returns {string|null} The extracted chunk, or null if extraction fails.
 */
export function extractChunkBySnippets_V2({ text, startSnippet, endSnippet }) {
  logger.debug(`[extractChunkBySnippets_V2] Called with:`);
  logger.debug(`  ┣━ Text (len ${text?.length}): "${text?.substring(0, 200).replace(/\n/g, '\\n')}..."`);
  logger.debug(`  ┣━ startSnippet (len ${startSnippet?.length}): "${startSnippet?.replace(/\n/g, '\\n')}"`);
  logger.debug(`  ┗━ endSnippet (len ${endSnippet?.length}): "${endSnippet?.replace(/\n/g, '\\n')}"`);

  if (typeof text !== 'string' || typeof startSnippet !== 'string') {
    logger.warn("[extractChunkBySnippets_V2] Invalid input: text or startSnippet is not a string or is missing.");
    return null;
  }

  const norm = (s) => {
    if (typeof s !== 'string') return s;
    return s
      .normalize('NFC')
      .replace(/[\u200E\u200F\u202A-\u202E]/g, '') // Bidi markers
      .replace(/[\"״׳׳"״׳׳"]/g, '"') // Unify various quote types to standard double quote
      .replace(/\s+/g, ' ') // Collapse multiple whitespace chars to a single space
      .trim();
  };

  let sIdx = -1;
  let effectiveStartSnippet = startSnippet;

  // 1. Find Start Snippet
  sIdx = text.indexOf(startSnippet);
  if (sIdx !== -1) {
    logger.debug(`[extractChunkBySnippets_V2] Found exact startSnippet at index ${sIdx}.`);
  } else {
    logger.debug(`[extractChunkBySnippets_V2] Exact startSnippet not found. Trying normalized version.`);
    const normalStart = norm(startSnippet);
    sIdx = text.indexOf(normalStart);
    if (sIdx !== -1) {
      logger.debug(`[extractChunkBySnippets_V2] Found normalized startSnippet ("${normalStart.replace(/\n/g, '\\n')}") at index ${sIdx}.`);
      effectiveStartSnippet = normalStart; // Use this for length calculations if matched
    } else {
      logger.warn(`[extractChunkBySnippets_V2] startSnippet (and its normalized form) NOT found in text.`);
      logger.debug(`  Attempted to find: "${startSnippet.replace(/\n/g, '\\n')}" and "${normalStart.replace(/\n/g, '\\n')}"`);
      return null;
    }
  }

  let eIdx_inclusiveEnd = text.length; // Default to end of text

  // 2. Find End Snippet (if provided)
  if (typeof endSnippet === 'string' && endSnippet.length > 0) {
    const searchFromForEnd = sIdx + effectiveStartSnippet.length;
    let foundEndSnippetText = endSnippet;
    let endSnippetStartPos = -1;

    // Try exact match for endSnippet (last occurrence after start)
    let tempEIdx = text.lastIndexOf(endSnippet);
    if (tempEIdx !== -1 && tempEIdx >= searchFromForEnd) {
      endSnippetStartPos = tempEIdx;
      logger.debug(`[extractChunkBySnippets_V2] Found exact endSnippet (lastIndexOf) at index ${endSnippetStartPos}.`);
    } else {
      tempEIdx = text.indexOf(endSnippet, searchFromForEnd);
      if (tempEIdx !== -1) {
        endSnippetStartPos = tempEIdx;
        logger.debug(`[extractChunkBySnippets_V2] Found exact endSnippet (indexOf) at index ${endSnippetStartPos}.`);
      }
    }

    if (endSnippetStartPos === -1) {
      logger.debug(`[extractChunkBySnippets_V2] Exact endSnippet not found. Trying normalized version.`);
      const normalEnd = norm(endSnippet);
      foundEndSnippetText = normalEnd; // If we match this, use its length

      tempEIdx = text.lastIndexOf(normalEnd);
      if (tempEIdx !== -1 && tempEIdx >= searchFromForEnd) {
        endSnippetStartPos = tempEIdx;
        logger.debug(`[extractChunkBySnippets_V2] Found normalized endSnippet ("${normalEnd.replace(/\n/g, '\\n')}") (lastIndexOf) at index ${endSnippetStartPos}.`);
      } else {
        tempEIdx = text.indexOf(normalEnd, searchFromForEnd);
        if (tempEIdx !== -1) {
          endSnippetStartPos = tempEIdx;
          logger.debug(`[extractChunkBySnippets_V2] Found normalized endSnippet ("${normalEnd.replace(/\n/g, '\\n')}") (indexOf) at index ${endSnippetStartPos}.`);
        }
      }
    }

    if (endSnippetStartPos !== -1) {
      eIdx_inclusiveEnd = endSnippetStartPos + foundEndSnippetText.length;
      logger.debug(`[extractChunkBySnippets_V2] End snippet found. Chunk will end at index ${eIdx_inclusiveEnd} (after "${foundEndSnippetText.replace(/\n/g, '\\n')}").`);
    } else {
      logger.warn(`[extractChunkBySnippets_V2] endSnippet (and its normalized form) NOT found after start. Chunk will extend to end of text.`);
      // eIdx_inclusiveEnd remains text.length
    }
  } else {
    logger.debug("[extractChunkBySnippets_V2] No endSnippet provided. Chunk will extend to end of text.");
    // eIdx_inclusiveEnd remains text.length
  }

  const chunk = text.slice(sIdx, eIdx_inclusiveEnd + 1);
  logger.debug(`[extractChunkBySnippets_V2] Slicing text from ${sIdx} to ${eIdx_inclusiveEnd}.`);
  logger.debug(`[extractChunkBySnippets_V2] Resulting chunk (len ${chunk?.length}): "${chunk?.substring(0, 200).replace(/\n/g, '\\n')}..."`);
  if (chunk.length > 200) logger.debug(`  ... (chunk continues) ... "${chunk?.substring(chunk.length - 200).replace(/\n/g, '\\n')}"`);


  return chunk;
}

/**
 * Improved version specifically for Hebrew text
 */
export function extractChunkBySnippets_V3({ text, startSnippet, endSnippet }) {
    logger.debug(`[extractChunkBySnippets_V3] Processing Hebrew text...`);
    
    // Special normalization for Hebrew text
    const hebrewNorm = (s) => {
        if (typeof s !== 'string') return s;
        return s
            .normalize('NFC')
            .replace(/[\u200E\u200F\u202A-\u202E]/g, '') // Remove bidi control chars
            .replace(/[\"״׳׳"״׳׳"]/g, '"')      // Normalize Hebrew quotes
            .replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, '') // Remove Hebrew diacritics
            .replace(/\s+/g, ' ')               // Collapse whitespace
            .trim();
    };
    
    // First try exact match
    let exactMatch = extractChunkBySnippets_V2({ text, startSnippet, endSnippet });
    if (exactMatch) return exactMatch;
    
    // If exact match fails, try with Hebrew normalization
    logger.debug(`[extractChunkBySnippets_V3] Exact match failed, trying Hebrew normalization...`);
    const normalizedText = hebrewNorm(text);
    const normalizedStart = hebrewNorm(startSnippet);
    const normalizedEnd = endSnippet ? hebrewNorm(endSnippet) : null;
    
    return extractChunkBySnippets_V2({ 
        text: normalizedText, 
        startSnippet: normalizedStart, 
        endSnippet: normalizedEnd 
    });
}

// ---------------------------------------------------------------------------
//  (anything that was already in this file continues unchanged below…)
// --------------------------------------------------------------------------- 