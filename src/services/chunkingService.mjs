// inside whatever function builds the chunk from the LLM response
function buildChunk({ llmResponse, sourceText }) {
  const {
    // from "index"-style replies
    charStart,
    charEnd,

    // from "snippet"-style replies
    startSnippet,
    endSnippet,
  } = llmResponse || {};

  logger.debug('[chunk] raw LLM response →',
    JSON.stringify({ charStart, charEnd, startSnippet, endSnippet })
  );

  let chunk;

  const haveIndices =
    Number.isFinite(charStart) &&
    Number.isFinite(charEnd)  &&
    charStart < charEnd;

  if (haveIndices) {
    logger.debug('[chunk] using CHARACTER-INDEX strategy');
    chunk = sourceText.slice(charStart, charEnd);
  } else if (startSnippet && endSnippet) {
    logger.debug('[chunk] using SNIPPET strategy');
    chunk = extractChunkBySnippets({ text: sourceText, startSnippet, endSnippet });
  } else {
    logger.warn(
      '[chunk] ⚠️  LLM response contained neither usable indices nor snippets – cannot build chunk.'
    );
    return null;
  }

  if (!chunk) {
    logger.warn('[chunk] ⚠️  extraction returned null (snippet(s) not found?)');
  }

  return chunk;
} 