-- Add token usage columns to chunk_metadata table
DO $$
BEGIN
    -- Check if input_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'input_tokens'
    ) THEN
        ALTER TABLE chunk_metadata ADD COLUMN input_tokens INTEGER;
        COMMENT ON COLUMN chunk_metadata.input_tokens IS 'Number of input tokens used in the API request';
        RAISE NOTICE 'Added input_tokens column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'input_tokens column already exists in chunk_metadata table';
    END IF;

    -- Check if output_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'output_tokens'
    ) THEN
        ALTER TABLE chunk_metadata ADD COLUMN output_tokens INTEGER;
        COMMENT ON COLUMN chunk_metadata.output_tokens IS 'Number of output tokens generated in the API response';
        RAISE NOTICE 'Added output_tokens column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'output_tokens column already exists in chunk_metadata table';
    END IF;

    -- Check if total_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'chunk_metadata' 
        AND column_name = 'total_tokens'
    ) THEN
        ALTER TABLE chunk_metadata ADD COLUMN total_tokens INTEGER;
        COMMENT ON COLUMN chunk_metadata.total_tokens IS 'Total number of tokens (input + output) used in the API call';
        RAISE NOTICE 'Added total_tokens column to chunk_metadata table';
    ELSE
        RAISE NOTICE 'total_tokens column already exists in chunk_metadata table';
    END IF;
END $$; 