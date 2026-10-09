import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(),
  keyHash: text('key_hash').notNull(), root: text('root').notNull(), terminal: integer('terminal').notNull(),
  lastSeen: integer('last_seen').notNull(), created: integer('created').notNull(), revoked: integer('revoked').notNull().default(0),
  capabilities: text('capabilities').notNull().default('{}')
});
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(), deviceId: text('device_id').notNull(), owner: text('owner').notNull(),
  operation: text('operation').notNull(), args: text('args').notNull(), state: text('state').notNull(),
  result: text('result'), created: integer('created').notNull(), completed: integer('completed'),
  approved: integer('approved').notNull().default(0)
}, t => [index('jobs_device_state').on(t.deviceId, t.state)]);
export const once = sqliteTable('once', { name: text('name').primaryKey(), used: integer('used').notNull() });
