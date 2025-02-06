import { pgTable, serial, text, integer, timestamp, varchar, jsonb, boolean } from "drizzle-orm/pg-core";

// Define tables
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

export const apiLogs = pgTable('api_logs', {
  id: serial('id').primaryKey(),
  requestType: varchar('request_type', { length: 50 }).notNull(), // 'chunk', 'sentiment', 'summary'
  requestPayload: jsonb('request_payload').notNull(),
  responsePayload: jsonb('response_payload').notNull(),
  success: boolean('success').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow()
});

export const chunkValidationLogs = pgTable('chunk_validation_logs', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').references(() => documents.id),
  chunkIndex: integer('chunk_index').notNull(),
  expectedFirstWord: varchar('expected_first_word', { length: 255 }).notNull(),
  expectedLastWord: varchar('expected_last_word', { length: 255 }).notNull(),
  actualFirstWord: varchar('actual_first_word', { length: 255 }).notNull(),
  actualLastWord: varchar('actual_last_word', { length: 255 }).notNull(),
  chunkText: text('chunk_text').notNull(),
  validationPassed: boolean('validation_passed').notNull(),
  validationError: text('validation_error'),
  createdAt: timestamp('created_at').defaultNow()
});

export const appLogs = pgTable('app_logs', {
  id: serial('id').primaryKey(),
  level: varchar('level', { length: 20 }).notNull(), // 'info', 'warn', 'error'
  message: text('message').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow()
});