-- Add model_used column to chunk_metadata table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'model_used'
    ) THEN
        ALTER TABLE chunk_metadata 
        ADD COLUMN model_used TEXT;
        
        COMMENT ON COLUMN chunk_metadata.model_used IS 'The LLM model used to generate this metadata';
        
        RAISE NOTICE 'Added model_used column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'model_used column already exists in chunk_metadata table';
    END IF;
END $$;

-- Comment on the new column
COMMENT ON COLUMN public.chunk_metadata.model_used IS 'The OpenAI model used to generate this metadata'; 