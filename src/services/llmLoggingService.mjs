import { documents } from '../schema.mjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const db = drizzle(pool);

export async function logLLMResponse(filepath, rawResponse, modelUsed) {
    try {
        // Insert a new document with the required fields
        const [document] = await db.insert(documents)
            .values({
                filepath: filepath || 'llm-log.txt',  // Provide a default filepath since it's required
                totalLength: rawResponse.length,
                resultType: 'log',
                content: {
                    raw_llm_response: rawResponse,
                    model: modelUsed,
                    timestamp: new Date().toISOString()
                }
            })
            .returning();

        return document;
    } catch (error) {
        console.error('Failed to log LLM response:', error);
        // Don't throw the error - we don't want logging failures to break the main flow
        return null;
    }
}

export async function getLLMResponseLog(documentId) {
    try {
        const [document] = await db
            .select({
                content: documents.content
            })
            .from(documents)
            .where(eq(documents.id, documentId));

        return document?.content?.raw_llm_response;
    } catch (error) {
        console.error('Failed to retrieve LLM response log:', error);
        return null;
    }
}