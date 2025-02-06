import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { documents, chunks, apiLogs, chunkValidationLogs } from '../schema.mjs';
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
                const chunkContent = content.substring(chunk.startIndex, chunk.endIndex);
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

export async function getRecentValidationLogs() {
    try {
        const logs = await db.select()
            .from(chunkValidationLogs)
            .orderBy(chunkValidationLogs.createdAt, 'desc')
            .limit(10);

        return logs.map(log => ({
            chunkIndex: log.chunkIndex,
            expectedBoundary: `"${log.expectedFirstWord}" to "${log.expectedLastWord}"`,
            actualBoundary: `"${log.actualFirstWord}" to "${log.actualLastWord}"`,
            chunkText: log.chunkText,
            error: log.validationError,
            passed: log.validationPassed
        }));
    } catch (error) {
        throw new Error(`Failed to get validation logs: ${error.message}`);
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

export async function getRecentApiLogs() {
    try {
        const logs = await db.select()
            .from(apiLogs)
            .orderBy(apiLogs.createdAt, 'desc')
            .limit(5);

        return logs.map(log => ({
            requestType: log.requestType,
            success: log.success,
            error: log.error,
            requestPayload: JSON.stringify(log.requestPayload, null, 2),
            responsePayload: JSON.stringify(log.responsePayload, null, 2)
        }));
    } catch (error) {
        throw new Error(`Failed to get API logs: ${error.message}`);
    }
}