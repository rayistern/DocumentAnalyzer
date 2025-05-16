import { pgTable, serial, text, integer, timestamp, varchar, uuid } from "drizzle-orm/pg-core";
import { setupProcessTimeout } from './config.mjs';

// Define tables
const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  filepath: varchar('filepath', { length: 255 }).notNull(),
  totalLength: integer('total_length').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});


// Set up the global timeout for all processes
setupProcessTimeout();


const chunks = pgTable('chunks', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').references(() => documents.id),
  startIndex: integer('start_index').notNull(),
  endIndex: integer('end_index').notNull(),
  firstWord: varchar('first_word', { length: 255 }).notNull(),
  lastWord: varchar('last_word', { length: 255 }).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

const chunkMetadata = pgTable('chunk_metadata', {
  id: serial('id').primaryKey(),
  documentId: uuid('document_id').references(() => documents.id),
  chunkId:    uuid('chunk_id').notNull().references(() => chunks.id),
  chunkIndex: integer('chunk_index'),
  /* …other fields… */
});

// Export as ES modules
export { documents, chunks };