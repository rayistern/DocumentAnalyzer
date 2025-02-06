import { pgTable, serial, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";

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

export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type InsertChunk = typeof chunks.$inferInsert;
