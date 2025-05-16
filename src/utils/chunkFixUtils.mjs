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

  const trimmedText     = chunkText.trimEnd();
  const trimmedSnippet  = endSnippet.trim();
  if (trimmedText.endsWith(trimmedSnippet)) return chunkText;      // already fine

  const baseText =
    trimmedText.length > 2 ? trimmedText.slice(0, -2).trimEnd() : '';

  const needsSpace =
    baseText.length > 0 &&
    !/\s$/.test(baseText) &&
    !/^[\s.,;!?]/.test(trimmedSnippet);

  return baseText + (needsSpace ? ' ' : '') + trimmedSnippet;
}

/* ------------------------------------------------------------------ */
/*  NEW  – start-index "band-aid"                                     */
/* ------------------------------------------------------------------ */
/**
 * Shift a start-index forward to skip the previous chunk's end-snippet.
 *
 * startIdx    – the start index currently chosen
 * prevSnippet – the full end-snippet of the previous chunk
 *
 * Returns: startIdx + (prevSnippet.length - 1)    // no shift if !prevSnippet
 */
export function shiftStartIndexByPrevSnippet(startIdx = 0, prevSnippet = '') {
  if (!prevSnippet) return startIdx;
  return startIdx + Math.max(prevSnippet.length - 1, 0);
} 