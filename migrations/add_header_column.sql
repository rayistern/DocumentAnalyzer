-- Add header column to documents table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'header'
    ) THEN
        ALTER TABLE documents 
        ADD COLUMN header TEXT;
        
        COMMENT ON COLUMN documents.header IS 'The first line of the document before cleaning, typically containing the document structure/path';
        
        RAISE NOTICE 'Added header column to documents table';
    ELSE
        RAISE NOTICE 'header column already exists in documents table';
    END IF;
END $$; 