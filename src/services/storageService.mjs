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
        const { filepath, type, content } = result;

        if (type === 'chunk') {
            // Save document first
            const [document] = await db.insert(documents)
                .values({
                    filepath,
                    totalLength: content.totalLength
                })
                .returning();

            // Save all chunks with their content
            const chunkPromises = content.chunks.map(chunk => {
                const chunkContent = content.substring(chunk.startIndex, chunk.endIndex + 1); // +1 to include the period.  Corrected the 'text' error here.
                return db.insert(chunks)
                    .values({
                        documentId: document.id,
                        startIndex: chunk.startIndex,
                        endIndex: chunk.endIndex,
                        firstWord: chunk.firstWord,
                        lastWord: chunk.lastWord,
                        content: chunkContent
                    });
            });

            await Promise.all(chunkPromises);
            return document;
        } else {
            throw new Error('Unsupported result type');
        }
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