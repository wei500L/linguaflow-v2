import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const times = { createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull() };

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  role: text('role').notNull().default('user'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  ...times
}, (table) => [uniqueIndex('users_email_unique').on(table.email)]);

export const authCodes = pgTable('auth_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  purpose: text('purpose').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  ...times
});

export const loginAttempts = pgTable('login_attempts', {
  email: text('email').primaryKey(),
  failures: integer('failures').notNull().default(0),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const entitlements = pgTable('entitlements', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  plan: text('plan').notNull().default('free'),
  planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  addonSeconds: integer('addon_seconds').notNull().default(0),
  usedSecondsThisPeriod: integer('used_seconds_this_period').notNull().default(0),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull().defaultNow(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active')
});

export const glossaries = pgTable('glossaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  languageA: text('language_a').notNull(),
  languageB: text('language_b').notNull(),
  presetKey: text('preset_key'),
  ...times
});

export const glossaryTerms = pgTable('glossary_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  glossaryId: uuid('glossary_id').notNull().references(() => glossaries.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  target: text('target').notNull(),
  pinned: boolean('pinned').notNull().default(false)
});

export const realtimeSessions = pgTable('realtime_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionTokenHash: text('session_token_hash').notNull(),
  mode: text('mode').notNull(),
  languageA: text('language_a').notNull(),
  languageB: text('language_b'),
  targetLanguage: text('target_language'),
  glossaryId: uuid('glossary_id').references(() => glossaries.id),
  maxSessionSeconds: integer('max_session_seconds').notNull().default(0),
  reservedSeconds: integer('reserved_seconds').notNull().default(0),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  billedSeconds: integer('billed_seconds').default(0),
  endReason: text('end_reason'),
  status: text('status').notNull().default('pending'),
  recordAudio: boolean('record_audio').notNull().default(true),
  title: text('title'),
  audienceTokenHash: text('audience_token_hash'),
  audienceToken: text('audience_token'),
  audienceIncludeAudio: boolean('audience_include_audio').notNull().default(false),
  audienceExpiresAt: timestamp('audience_expires_at', { withTimezone: true }),
  audienceRevokedAt: timestamp('audience_revoked_at', { withTimezone: true }),
  ...times
}, (table) => [uniqueIndex('realtime_audience_token_hash_unique').on(table.audienceTokenHash)]);

export const summaryProviders = pgTable('summary_providers', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  apiBase: text('api_base').notNull(),
  apiKeyCipher: text('api_key_cipher'),
  model: text('model').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const transcriptFolders = pgTable('transcript_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ...times
});

export const transcripts = pgTable('transcripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionId: uuid('session_id').references(() => realtimeSessions.id),
  title: text('title').notNull(),
  mode: text('mode').notNull().default('one_way'),
  languageA: text('language_a').notNull(),
  languageB: text('language_b').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  summaryMarkdown: text('summary_markdown'),
  summaryStatus: text('summary_status').notNull().default('none'),
  summaryError: text('summary_error'),
  summaryTemplate: text('summary_template'),
  summaryLanguage: text('summary_language'),
  summaryModel: text('summary_model'),
  summarySourceHash: text('summary_source_hash'),
  summaryGeneratedAt: timestamp('summary_generated_at', { withTimezone: true }),
  summaryEditedAt: timestamp('summary_edited_at', { withTimezone: true }),
  summaryBilling: text('summary_billing'),
  summaryChecks: jsonb('summary_checks').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  audioRelPath: text('audio_rel_path'),
  audioStatus: text('audio_status').notNull().default('none'),
  audioFormat: text('audio_format'),
  audioBytes: integer('audio_bytes'),
  audioDurationMs: integer('audio_duration_ms'),
  audioError: text('audio_error'),
  folderId: uuid('folder_id').references(() => transcriptFolders.id, { onDelete: 'set null' }),
  starred: boolean('starred').notNull().default(false),
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
  ...times
});

export const transcriptTasks = pgTable('transcript_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  transcriptId: uuid('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  done: boolean('done').notNull().default(false),
  position: integer('position').notNull().default(0)
});

export const usageLedger = pgTable('usage_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  sessionId: uuid('session_id').references(() => realtimeSessions.id),
  transcriptId: uuid('transcript_id').references(() => transcripts.id, { onDelete: 'cascade' }),
  seconds: integer('seconds').notNull(),
  source: text('source').notNull(),
  kind: text('kind').notNull().default('session'),
  status: text('status').notNull().default('settled'),
  ...times
});

export const transcriptSegments = pgTable('transcript_segments', {
  id: uuid('id').primaryKey().defaultRandom(),
  transcriptId: uuid('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  speaker: text('speaker'),
  language: text('language'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  sourceText: text('source_text').notNull().default(''),
  translationText: text('translation_text').notNull().default(''),
  confidence: integer('confidence')
});

export const activationCodes = pgTable('activation_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull(),
  codePrefix: text('code_prefix').notNull(),
  plan: text('plan'),
  months: integer('months'),
  addonSeconds: integer('addon_seconds').notNull().default(0),
  note: text('note'),
  maxRedemptions: integer('max_redemptions').notNull().default(1),
  redemptionCount: integer('redemption_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  disabled: boolean('disabled').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id),
  ...times
}, (table) => [uniqueIndex('activation_code_hash_unique').on(table.codeHash)]);

export const redemptions = pgTable('redemptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeId: uuid('code_id').notNull().references(() => activationCodes.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  grantedPlan: text('granted_plan'),
  grantedMonths: integer('granted_months'),
  grantedAddonSeconds: integer('granted_addon_seconds').notNull().default(0)
});

export const transcriptShares = pgTable('transcript_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  transcriptId: uuid('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  token: text('token'),
  includeAudio: boolean('include_audio').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  passwordHash: text('password_hash'),
  viewCount: integer('view_count').notNull().default(0),
  scope: text('scope').notNull().default('full'),
  ...times
}, (table) => [uniqueIndex('transcript_share_hash_unique').on(table.tokenHash)]);

export const adminAudit = pgTable('admin_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').references(() => users.id),
  action: text('action').notNull(),
  targetUserId: uuid('target_user_id').references(() => users.id),
  payloadJson: jsonb('payload_json'),
  ...times
});
