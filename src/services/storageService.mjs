import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

export async function saveResult(result) {
    try {
        const { filepath, type, content, timestamp } = result;
        const query = `
            INSERT INTO text_processing_results (filepath, type, content, timestamp)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        const values = [filepath, type, content, timestamp];
        const res = await pool.query(query, values);
        return res.rows[0];
    } catch (error) {
        throw new Error(`Database error: ${error.message}`);
    }
}

export async function getResults() {
    try {
        const query = 'SELECT * FROM text_processing_results ORDER BY timestamp DESC';
        const res = await pool.query(query);
        return res.rows;
    } catch (error) {
        throw new Error(`Database error: ${error.message}`);
    }
}

export async function clearResults() {
    try {
        await pool.query('TRUNCATE text_processing_results');
    } catch (error) {
        throw new Error(`Database error: ${error.message}`);
    }
}