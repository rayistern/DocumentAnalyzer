-- Add prechunk_id column to chunks table to connect chunks with their source prechunks
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunks' 
        AND column_name = 'prechunk_id'
    ) THEN
        ALTER TABLE chunks 
        ADD COLUMN prechunk_id UUID REFERENCES prechunks(id);
        
        COMMENT ON COLUMN chunks.prechunk_id IS 'Foreign key reference to the source prechunk';
        
        RAISE NOTICE 'Added prechunk_id column to chunks table';
    ELSE
        RAISE NOTICE 'prechunk_id column already exists in chunks table';
    END IF;
END $$; 