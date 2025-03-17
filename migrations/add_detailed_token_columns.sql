-- Add detailed token usage columns to both tables
DO $$
BEGIN
    -- Add reasoning_tokens column to chunk_metadata
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'reasoning_tokens'
    ) THEN
        ALTER TABLE chunk_metadata ADD COLUMN reasoning_tokens INTEGER;
        COMMENT ON COLUMN chunk_metadata.reasoning_tokens IS 'Number of reasoning tokens used in completion';
        RAISE NOTICE 'Added reasoning_tokens column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'reasoning_tokens column already exists in chunk_metadata table';
    END IF;

    -- Add cached_tokens column to chunk_metadata
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'cached_tokens'
    ) THEN
        ALTER TABLE chunk_metadata ADD COLUMN cached_tokens INTEGER;
        COMMENT ON COLUMN chunk_metadata.cached_tokens IS 'Number of cached tokens used in the prompt';
        RAISE NOTICE 'Added cached_tokens column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'cached_tokens column already exists in chunk_metadata table';
    END IF;

    -- Add reasoning_tokens column to documents
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'reasoning_tokens'
    ) THEN
        ALTER TABLE documents ADD COLUMN reasoning_tokens INTEGER;
        COMMENT ON COLUMN documents.reasoning_tokens IS 'Number of reasoning tokens used in completion';
        RAISE NOTICE 'Added reasoning_tokens column to documents table';
    ELSE
        RAISE NOTICE 'reasoning_tokens column already exists in documents table';
    END IF;

    -- Add cached_tokens column to documents
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'cached_tokens'
    ) THEN
        ALTER TABLE documents ADD COLUMN cached_tokens INTEGER;
        COMMENT ON COLUMN documents.cached_tokens IS 'Number of cached tokens used in the prompt';
        RAISE NOTICE 'Added cached_tokens column to documents table';
    ELSE
        RAISE NOTICE 'cached_tokens column already exists in documents table';
    END IF;
END $$; 