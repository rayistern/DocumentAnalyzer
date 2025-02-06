import { pgTable, serial, text, integer, timestamp, varchar, json } from "drizzle-orm/pg-core";

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  filepath: varchar('filepath', { length: 255 }).notNull(),
  totalLength: integer('total_length').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

export const chunks = pgTable('chunks', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').references(() => documents.id),
  startIndex: integer('start_index').notNull(),
  endIndex: integer('end_index').notNull(),
  firstWord: varchar('first_word', { length: 255 }).notNull(),
  lastWord: varchar('last_word', { length: 255 }).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

// New table for LLM responses
export const llmResponses = pgTable('llm_responses', {
  id: serial('id').primaryKey(),
  requestType: varchar('request_type', { length: 50 }).notNull(), // 'sentiment', 'summary', etc.
  inputText: text('input_text').notNull(),
  response: json('response').notNull(), // Store the complete response
  model: varchar('model', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  processingTime: integer('processing_time'), // in milliseconds
  documentId: integer('document_id').references(() => documents.id),
  status: varchar('status', { length: 20 }).notNull() // 'success' or 'error'
});

export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type InsertChunk = typeof chunks.$inferInsert;
export type LLMResponse = typeof llmResponses.$inferSelect;
export type InsertLLMResponse = typeof llmResponses.$inferInsert;