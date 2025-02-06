import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { documents, chunks } from '../schema.mjs';
import { eq } from 'drizzle-orm';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const db = drizzle(pool);

export async function saveResult(result) {
    try {
        const { filepath, type, content, originalText, warnings = [] } = result;

        // Base document data
        const documentData = {
            filepath,
            totalLength: originalText ? originalText.length : 0,
            resultType: type,
            warnings: warnings.join('\n'),
            content: type !== 'chunk' ? content : null // Store content directly for non-chunk types
        };

        // Save document
        const [document] = await db.insert(documents)
            .values(documentData)
            .returning();

        // Only store chunks for chunk type results
        if (type === 'chunk' && content.chunks) {
            const chunkPromises = content.chunks.map(chunk => {
                return db.insert(chunks)
                    .values({
                        documentId: document.id,
                        startIndex: chunk.startIndex,
                        endIndex: chunk.endIndex,
                        firstWord: chunk.firstWord,
                        lastWord: chunk.lastWord,
                        content: originalText.slice(chunk.startIndex - 1, chunk.endIndex)
                    });
            });

            await Promise.all(chunkPromises);
        }

        return document;
    } catch (error) {
        throw new Error(`Database error: ${error.message}`);
    }
}

export async function getResults() {
    try {
        const results = await db.select()
            .from(documents)
            .leftJoin(chunks, eq(documents.id, chunks.documentId));

        return results.reduce((acc, row) => {
            if (!acc[row.documents.id]) {
                acc[row.documents.id] = {
                    ...row.documents,
                    chunks: []
                };
            }
            if (row.chunks) {
                acc[row.documents.id].chunks.push(row.chunks);
            }
            return acc;
        }, {});
    } catch (error) {
        throw new Error(`Database error: ${error.message}`);
    }
}

export async function getDocumentChunks(documentId) {
    try {
        return await db.select()
            .from(chunks)
            .where(eq(chunks.documentId, documentId));
    } catch (error) {
        throw new Error(`Database error: ${error.message}`);
    }
}