# Document Analyzer

A system for semantic document processing, chunking, and analysis using LLMs.

## Overview

Document Analyzer processes large documents by:
1. Breaking them into semantically meaningful chunks
2. Cleaning unwanted text
3. Generating metadata
4. Preserving text continuity across chunk boundaries

The system is designed to handle documents of any size by processing them in manageable pieces while maintaining semantic integrity.

## Key Features

- **Semantic Chunking**: Documents are divided at logical boundaries (paragraphs, sentences) rather than arbitrary positions
- **Continuity Preservation**: Text that spans chunk boundaries is handled properly through remainder text
- **Multi-document Support**: Continuation mode allows processing across file boundaries
- **Metadata Generation**: Each chunk can have associated metadata for easier retrieval

## Architecture

The system consists of several key components:

- **Pre-chunking Service**: Initial division of documents into fixed-size pieces
- **OpenAI Service**: Core processing using LLMs for cleaning, chunking, and metadata
- **Supabase Service**: Database storage for documents, chunks, and metadata
- **Error Handling Service**: Strategies for handling failures and retries

## Document Processing Flow

The exact sequence of operations is:

```
                           ┌──── Extract Remainder for Next Iteration ────┐
                           │                                             │
                           ▼                                             │
Document → Pre-chunks → Clean Raw Pre-chunk → Combine with Remainder → Semantic Chunking
                                                   ▲
                                                   │
                  Previous Document Context (optional)┘
```

Key points:
1. Cleaning happens ONLY on the raw pre-chunk text (to remove headers, footers, etc.)
2. Remainder text (which is already cleaned) is combined with cleaned pre-chunk
3. Previous document context may be added to the combined text (only for first pre-chunk)
4. Remainder for next iteration is extracted after chunking and is not cleaned again

See `docs/document_processing.md` for a detailed explanation of the processing flow.

## Remainder Text Mechanism

A critical part of the system is how text continuity is maintained across chunks:

1. Each semantic chunking process creates a "remainder" - text after the last chunk that will be carried forward
2. This remainder is already cleaned and should NOT be cleaned again
3. It is prepended to the next pre-chunk's cleaned text before semantic chunking
4. This ensures text that spans pre-chunk boundaries is processed together correctly

## Debugging Tips

When troubleshooting issues:

1. **Missing Remainder**: Check if `remainderText` is correctly carried forward between pre-chunks
2. **Text Cleaning Issues**: Verify if text removal is affecting the remainder
3. **Chunking Boundaries**: Ensure chunk positions align with semantic breaks
4. **Text Length Validation**: Verify that chunk lengths match expected document length

## Common Issues

- **Unexpected Cleaning**: The cleaning process might remove important text - check the textToRemove positions
- **Text Position Mismatch**: LLM position calculations might not match text positions exactly
- **Remainder Loss**: Something might be removing or not including the remainder correctly

## See Also

- `docs/document_processing.md` - Detailed process documentation
- `src/services/openaiService.mjs` - Core processing logic
- `src/services/preChunkingService.mjs` - Pre-chunking functionality 