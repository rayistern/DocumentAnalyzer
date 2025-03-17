-- Add bibliography_snippets column to chunk_metadata table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'bibliography_snippets'
    ) THEN
        ALTER TABLE chunk_metadata 
        ADD COLUMN bibliography_snippets JSONB;
        
        COMMENT ON COLUMN chunk_metadata.bibliography_snippets IS 'Array of bibliography snippets with source references';
        
        RAISE NOTICE 'Added bibliography_snippets column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'bibliography_snippets column already exists in chunk_metadata table';
    END IF;
END $$; 