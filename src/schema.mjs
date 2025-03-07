import { pgTable, uuid, text, timestamp, varchar, jsonb, integer } from "drizzle-orm/pg-core";

export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  content: text('content').notNull(),
  type: text('type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  warnings: text('warnings').array(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  documentSourceId: uuid('document_source_id').references(() => documentSources.id),
  longDescription: text('long_description'),
  keywords: text('keywords').array(),
  questionsAnswered: text('questions_answered').array(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  rawLlmResponse: text('raw_llm_response'),
  errorMessage: text('error_message'),
  status: text('status').default('processing'),
  apiMetadata: jsonb('api_metadata'),
  contentHash: text('content_hash'),
  duplicateOf: uuid('duplicate_of').references(() => documents.id)
});

// Global timeout setting in hours
const GLOBAL_TIMEOUT_HOURS = 10;

// Add automatic timeout function
function setupProcessTimeout(hours = GLOBAL_TIMEOUT_HOURS) {
    const timeoutMs = hours * 60 * 60 * 1000; // Convert hours to milliseconds
    console.log(`\n[${new Date().toISOString()}] ⏱️ Setting up automatic timeout after ${hours} hours`);
    
    setTimeout(() => {
        console.log(`\n[${new Date().toISOString()}] ⏱️ AUTOMATIC TIMEOUT TRIGGERED after ${hours} hours`);
        console.log(`[${new Date().toISOString()}] Process is being terminated to prevent runaway execution`);
        process.exit(0);
    }, timeoutMs);
}

// Set up the global timeout for all processes
setupProcessTimeout();


export const documentSources = pgTable('document_sources', {
  id: uuid('id').defaultRandom().primaryKey(),
  filename: text('filename').notNull(),
  originalContent: text('original_content').notNull(),
  status: text('status').notNull(),
  cleanedContent: text('cleaned_content'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  groupNumber: text('group_number')
});

export const chunks = pgTable('chunks', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').references(() => documents.id),
  documentSourceId: uuid('document_source_id').references(() => documentSources.id),
  startIndex: text('start_index').notNull(),
  endIndex: text('end_index').notNull(),
  firstWord: text('first_word').notNull(),
  lastWord: text('last_word').notNull(),
  cleanedText: text('cleaned_text').notNull(),
  originalText: text('original_text').notNull(),
  warnings: text('warnings'),
  rawMetadata: jsonb('raw_metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const cleanedDocuments = pgTable('cleaned_documents', {
    id: integer('id').references(() => documents.id).primaryKey(),
    cleaned_content: text('cleaned_content').notNull(),
    original_document: text('original_document').notNull(),
    llm_model: varchar('llm_model', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow()
});