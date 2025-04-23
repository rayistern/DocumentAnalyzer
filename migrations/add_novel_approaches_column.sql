-- Add novel_approaches column to chunk_metadata table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'novel_approaches'
    ) THEN
        ALTER TABLE chunk_metadata 
        ADD COLUMN novel_approaches TEXT[];
        
        COMMENT ON COLUMN chunk_metadata.novel_approaches IS 'Array of viewpoints or methods unique to this text that can be used to guide AI behavior';
        
        RAISE NOTICE 'Added novel_approaches column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'novel_approaches column already exists in chunk_metadata table';
    END IF;
END $$; 