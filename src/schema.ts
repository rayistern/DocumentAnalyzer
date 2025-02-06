import { pgTable, serial, text, integer, timestamp, varchar, jsonb } from "drizzle-orm/pg-core";

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

export const llmLogs = pgTable('llm_logs', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').references(() => documents.id),
  requestType: varchar('request_type', { length: 50 }).notNull(), // 'sentiment', 'summary', 'chunk'
  prompt: text('prompt').notNull(),
  response: jsonb('response').notNull(),
  tokens: integer('tokens'),
  duration: integer('duration_ms'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow()
});

export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type InsertChunk = typeof chunks.$inferInsert;
export type LLMLog = typeof llmLogs.$inferSelect;
export type InsertLLMLog = typeof llmLogs.$inferInsert;