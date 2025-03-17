-- Add raw_llm_response column to chunk_metadata table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'raw_llm_response'
    ) THEN
        ALTER TABLE chunk_metadata 
        ADD COLUMN raw_llm_response TEXT;
        
        COMMENT ON COLUMN chunk_metadata.raw_llm_response IS 'The raw LLM response text, stored for debugging parsing failures';
        
        RAISE NOTICE 'Added raw_llm_response column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'raw_llm_response column already exists in chunk_metadata table';
    END IF;
END $$; 