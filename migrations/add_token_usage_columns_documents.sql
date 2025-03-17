-- Add token usage columns to documents table
DO $$
BEGIN
    -- Check if input_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'input_tokens'
    ) THEN
        ALTER TABLE documents ADD COLUMN input_tokens INTEGER;
        COMMENT ON COLUMN documents.input_tokens IS 'Number of input tokens used in the API request';
        RAISE NOTICE 'Added input_tokens column to documents table';
    ELSE
        RAISE NOTICE 'input_tokens column already exists in documents table';
    END IF;

    -- Check if output_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'output_tokens'
    ) THEN
        ALTER TABLE documents ADD COLUMN output_tokens INTEGER;
        COMMENT ON COLUMN documents.output_tokens IS 'Number of output tokens generated in the API response';
        RAISE NOTICE 'Added output_tokens column to documents table';
    ELSE
        RAISE NOTICE 'output_tokens column already exists in documents table';
    END IF;

    -- Check if total_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'documents' 
        AND column_name = 'total_tokens'
    ) THEN
        ALTER TABLE documents ADD COLUMN total_tokens INTEGER;
        COMMENT ON COLUMN documents.total_tokens IS 'Total number of tokens (input + output) used in the API call';
        RAISE NOTICE 'Added total_tokens column to documents table';
    ELSE
        RAISE NOTICE 'total_tokens column already exists in documents table';
    END IF;
END $$; 