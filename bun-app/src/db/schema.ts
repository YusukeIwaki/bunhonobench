import { pgTable, serial, varchar, text, timestamp } from 'drizzle-orm/pg-core';

export const articles = pgTable('articles', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export type Article = typeof articles.$inferSelect;
