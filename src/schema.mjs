import { pgTable, serial, text, integer, timestamp, varchar, jsonb } from "drizzle-orm/pg-core";

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  filepath: varchar('filepath', { length: 255 }).notNull(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
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
  warnings: text('warnings'),
  createdAt: timestamp('created_at').defaultNow()
});

export const cleanedDocuments = pgTable('cleaned_documents', {
    id: integer('id').references(() => documents.id).primaryKey(),
    cleaned_content: text('cleaned_content').notNull(),
    original_document: text('original_document').notNull(),
    llm_model: varchar('llm_model', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow()
});