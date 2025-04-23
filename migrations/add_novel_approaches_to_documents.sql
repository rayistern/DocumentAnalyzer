-- Add novel_approaches column to documents table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'novel_approaches'
    ) THEN
        ALTER TABLE documents 
        ADD COLUMN novel_approaches TEXT[];
        
        COMMENT ON COLUMN documents.novel_approaches IS 'Array of viewpoints or methods unique to this text that can be used to guide AI behavior';
        
        RAISE NOTICE 'Added novel_approaches column to documents table';
    ELSE
        RAISE NOTICE 'novel_approaches column already exists in documents table';
    END IF;
END $$; 