-- Link existing chunks to their corresponding prechunks
-- This is a one-time migration to set prechunk_id for existing chunks

DO $$
DECLARE
    chunk RECORD;
BEGIN
    -- Process each chunk that doesn't already have a prechunk_id
    FOR chunk IN 
        SELECT id, document_id, start_index::int, end_index::int 
        FROM chunks 
        WHERE prechunk_id IS NULL
    LOOP
        -- Update the chunk with the prechunk_id that most closely matches its position
        -- We look for a prechunk from the same document that contains the chunk's start position
        UPDATE chunks 
        SET prechunk_id = (
            SELECT p.id 
            FROM prechunks p
            WHERE p.document_id = chunk.document_id
              AND p.start_position <= chunk.start_index
              AND p.end_position >= chunk.start_index
            ORDER BY (p.end_position - p.start_position) ASC
            LIMIT 1
        )
        WHERE id = chunk.id;
        
        -- If we couldn't find a match by start position, try using document_id only
        -- and finding the prechunk with the closest start position
        IF NOT FOUND THEN
            UPDATE chunks 
            SET prechunk_id = (
                SELECT p.id 
                FROM prechunks p
                WHERE p.document_id = chunk.document_id
                ORDER BY ABS(p.start_position - chunk.start_index) ASC
                LIMIT 1
            )
            WHERE id = chunk.id AND prechunk_id IS NULL;
        END IF;
    END LOOP;
    
    -- Log the results
    RAISE NOTICE 'Chunks updated: %', (SELECT COUNT(*) FROM chunks WHERE prechunk_id IS NOT NULL);
    RAISE NOTICE 'Chunks remaining without prechunk_id: %', (SELECT COUNT(*) FROM chunks WHERE prechunk_id IS NULL);
END $$; 