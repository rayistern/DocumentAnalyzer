import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { llmResponses } from '../schema.js';
import { storageLogger as logger } from './loggingService.mjs';

// Initialize the database connection
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

export async function logLLMResponse({
  requestType,
  inputText,
  response,
  model,
  processingTime,
  documentId,
  status
}) {
  try {
    // Log the attempt to save to database
    await logger.info('Attempting to log LLM response to database', {
      requestType,
      model,
      status,
      processingTime
    });

    const [result] = await db.insert(llmResponses).values({
      requestType,
      inputText,
      response: typeof response === 'string' ? { content: response } : response,
      model,
      processingTime,
      documentId,
      status
    }).returning();

    await logger.info('Logged LLM response to database', {
      id: result.id,
      requestType,
      status
    });

    return result;
  } catch (error) {
    await logger.error('Failed to log LLM response to database', error, {
      requestType,
      model,
      status
    });
    throw error;
  }
}

export async function getLLMResponses() {
  try {
    return await db.select().from(llmResponses).orderBy(llmResponses.createdAt);
  } catch (error) {
    await logger.error('Failed to retrieve LLM responses', error);
    throw error;
  }
}