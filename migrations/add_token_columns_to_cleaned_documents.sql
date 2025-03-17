-- Add token usage columns to cleaned_documents table
DO $$
BEGIN
    -- Check if input_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cleaned_documents' 
        AND column_name = 'input_tokens'
    ) THEN
        ALTER TABLE cleaned_documents ADD COLUMN input_tokens INTEGER;
        COMMENT ON COLUMN cleaned_documents.input_tokens IS 'Number of input tokens used in the API request';
        RAISE NOTICE 'Added input_tokens column to cleaned_documents table';
    ELSE
        RAISE NOTICE 'input_tokens column already exists in cleaned_documents table';
    END IF;

    -- Check if output_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cleaned_documents' 
        AND column_name = 'output_tokens'
    ) THEN
        ALTER TABLE cleaned_documents ADD COLUMN output_tokens INTEGER;
        COMMENT ON COLUMN cleaned_documents.output_tokens IS 'Number of output tokens generated in the API response';
        RAISE NOTICE 'Added output_tokens column to cleaned_documents table';
    ELSE
        RAISE NOTICE 'output_tokens column already exists in cleaned_documents table';
    END IF;

    -- Check if total_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cleaned_documents' 
        AND column_name = 'total_tokens'
    ) THEN
        ALTER TABLE cleaned_documents ADD COLUMN total_tokens INTEGER;
        COMMENT ON COLUMN cleaned_documents.total_tokens IS 'Total number of tokens (input + output) used in the API call';
        RAISE NOTICE 'Added total_tokens column to cleaned_documents table';
    ELSE
        RAISE NOTICE 'total_tokens column already exists in cleaned_documents table';
    END IF;

    -- Check if reasoning_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cleaned_documents' 
        AND column_name = 'reasoning_tokens'
    ) THEN
        ALTER TABLE cleaned_documents ADD COLUMN reasoning_tokens INTEGER;
        COMMENT ON COLUMN cleaned_documents.reasoning_tokens IS 'Number of reasoning tokens used in completion';
        RAISE NOTICE 'Added reasoning_tokens column to cleaned_documents table';
    ELSE
        RAISE NOTICE 'reasoning_tokens column already exists in cleaned_documents table';
    END IF;

    -- Check if cached_tokens column exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'cleaned_documents' 
        AND column_name = 'cached_tokens'
    ) THEN
        ALTER TABLE cleaned_documents ADD COLUMN cached_tokens INTEGER;
        COMMENT ON COLUMN cleaned_documents.cached_tokens IS 'Number of cached tokens used in the prompt';
        RAISE NOTICE 'Added cached_tokens column to cleaned_documents table';
    ELSE
        RAISE NOTICE 'cached_tokens column already exists in cleaned_documents table';
    END IF;
END $$; 