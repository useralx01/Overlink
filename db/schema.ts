import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
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

export const meshTransfers = sqliteTable('mesh_transfers', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  fromDevice: text('from_device').notNull(),
  targetDevice: text('target_device').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  filename: text('filename').notNull().default(''),
  content: text('content').notNull(),
  bytes: integer('bytes').notNull(),
  created: integer('created').notNull(),
  expires: integer('expires').notNull(),
  state: text('state').notNull().default('queued'),
  delivered: integer('delivered')
}, t => [
  index('mesh_transfers_inbox').on(t.owner,t.targetDevice,t.state,t.created),
  index('mesh_transfers_expiry').on(t.expires),
  check('mesh_kind', sql`${t.kind} IN ('text','handoff','file')`),
  check('mesh_state', sql`${t.state} IN ('queued','delivered')`)
]);
