/**
 * Ensure the chunk's cleaned text truly ends with its end-snippet.
 *
 * Logic:
 * 1. If `endSnippet` is empty → return the original text.
 * 2. Trim trailing whitespace from the chunk and leading/trailing whitespace
 *    from the snippet.
 * 3. If the trimmed chunk already ends with the trimmed snippet → return
 *    original text (no change).
 * 4. Otherwise append the snippet, inserting ONE space when needed so we
 *    don't merge words or double-punctuate.
 */
export function appendEndSnippetIfMissing(chunkText = '', endSnippet = '') {
  if (!endSnippet) return chunkText;

  const trimmedText    = chunkText.trimEnd();
  const trimmedSnippet = endSnippet.trim();

  if (trimmedText.endsWith(trimmedSnippet)) return chunkText;  // already there

  const needsSpace =
    trimmedText.length > 0 &&                   // non-empty chunk
    !/\s$/.test(trimmedText) &&                 // chunk doesn't already end in space
    !/^[\s.,;!?]/.test(trimmedSnippet);         // snippet doesn't start with punctuation/space

  return trimmedText + (needsSpace ? ' ' : '') + trimmedSnippet;
} 