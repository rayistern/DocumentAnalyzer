import { pgTable, serial, text, integer, timestamp, varchar, jsonb } from "drizzle-orm/pg-core";

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  filepath: varchar('filepath', { length: 255 }).notNull(),
  totalLength: integer('total_length').notNull(),
  resultType: varchar('result_type', { length: 20 }).notNull(), // 'summary', 'sentiment', or 'chunk'
  content: jsonb('content'), // Store the JSON result for summary and sentiment
  warnings: text('warnings'),
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

export const llmResponses = pgTable('llm_responses', {
  id: serial('id').primaryKey(),
  model: varchar('model', { length: 50 }).notNull(),
  prompt: text('prompt').notNull(),
  response: jsonb('response').notNull(),
  processingTime: integer('processing_time_ms'),
  createdAt: timestamp('created_at').defaultNow(),
  type: varchar('type', { length: 50 }).notNull() // 'sentiment', 'summary', or 'chunk'
});