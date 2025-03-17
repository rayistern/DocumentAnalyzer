-- Fix bibliography_snippets and identified_abbreviations column types in chunk_metadata table
DO $$
BEGIN
    -- Alter bibliography_snippets to JSONB (from JSONB[])
    ALTER TABLE chunk_metadata 
    ALTER COLUMN bibliography_snippets TYPE JSONB USING NULL;

    -- Alter identified_abbreviations to JSONB (from JSONB[])
    ALTER TABLE chunk_metadata 
    ALTER COLUMN identified_abbreviations TYPE JSONB USING NULL;

    RAISE NOTICE 'Changed bibliography_snippets and identified_abbreviations from JSONB[] to JSONB';
END $$; 