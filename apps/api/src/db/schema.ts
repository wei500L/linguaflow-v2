import type { AudioGap, PersistedSegment } from '@linguaflow/shared';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const times = { createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull() };

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  role: text('role').notNull().default('user'),
  inviteCode: text('invite_code'),
  tokenVersion: integer('token_version').notNull().default(0),
  signupIp: text('signup_ip'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  ...times
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
  uniqueIndex('users_invite_code_unique').on(table.inviteCode)
]);

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

export const courses = pgTable('courses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  languageA: text('language_a').notNull(),
  languageB: text('language_b').notNull(),
  mode: text('mode').notNull().default('one_way'),
  glossaryId: uuid('glossary_id').references(() => glossaries.id, { onDelete: 'set null' }),
  recordAudio: boolean('record_audio').notNull().default(true),
  summaryTemplate: text('summary_template').notNull().default('classroom'),
  titlePattern: text('title_pattern'),
  ...times,
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
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
  fingerprintHash: text('fingerprint_hash'),
  deviceId: text('device_id'),
  ownerInstanceId: text('owner_instance_id'),
  ownerHeartbeatAt: timestamp('owner_heartbeat_at', { withTimezone: true }),
  checkpointAt: timestamp('checkpoint_at', { withTimezone: true }),
  checkpointSeq: integer('checkpoint_seq').notNull().default(0),
  audioMs: integer('audio_ms').notNull().default(0),
  activeUntil: timestamp('active_until', { withTimezone: true }),
  saveStatus: text('save_status').notNull().default('pending'),
  saveError: text('save_error'),
  persistedTokenCount: integer('persisted_token_count').notNull().default(0),
  segmentSnapshot: jsonb('segment_snapshot').$type<PersistedSegment[]>().notNull().default(sql`'[]'::jsonb`),
  speakerNames: jsonb('speaker_names').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  gaps: jsonb('gaps').$type<AudioGap[]>().notNull().default(sql`'[]'::jsonb`),
  shareIntent: text('share_intent').notNull().default('personal'),
  audienceKeepAfter: boolean('audience_keep_after').notNull().default(false),
  courseId: uuid('course_id').references(() => courses.id, { onDelete: 'set null' }),
  recordingRelPath: text('recording_rel_path'),
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
  recordStatus: text('record_status').notNull().default('complete'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  courseId: uuid('course_id').references(() => courses.id, { onDelete: 'set null' }),
  gaps: jsonb('gaps').$type<AudioGap[]>().notNull().default(sql`'[]'::jsonb`),
  summaryStale: boolean('summary_stale').notNull().default(false),
  summaryInputVersion: integer('summary_input_version').notNull().default(0),
  summaryCitationHashes: jsonb('summary_citation_hashes').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  summaryCitationsVerified: boolean('summary_citations_verified').notNull().default(true),
  noteEpoch: integer('note_epoch').notNull().default(0),
  ...times
}, (table) => [
  index('transcripts_user_deleted_idx').on(table.userId, table.deletedAt),
  uniqueIndex('transcripts_session_unique').on(table.sessionId)
]);

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
  requestId: uuid('request_id'),
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
  confidence: integer('confidence'),
  sourceHash: text('source_hash')
});

export const sessionTokenChunks = pgTable('session_token_chunks', {
  sessionId: uuid('session_id').notNull().references(() => realtimeSessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  tokens: jsonb('tokens').notNull(),
  ...times
}, (table) => [primaryKey({ columns: [table.sessionId, table.seq] })]);

export const sessionMarkers = pgTable('session_markers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => realtimeSessions.id, { onDelete: 'cascade' }),
  transcriptId: uuid('transcript_id').references(() => transcripts.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  note: text('note'),
  wallMs: integer('wall_ms'),
  audioMs: integer('audio_ms'),
  segmentId: uuid('segment_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...times,
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => [index('session_markers_session_idx').on(table.sessionId), index('session_markers_transcript_idx').on(table.transcriptId)]);

export const noteVersions = pgTable('note_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  transcriptId: uuid('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  authorType: text('author_type').notNull(),
  template: text('template'),
  inputVersion: integer('input_version'),
  provider: text('provider'),
  body: text('body').notNull(),
  inputHash: text('input_hash'),
  outputLanguage: text('output_language'),
  citationHashes: jsonb('citation_hashes').$type<Record<string, string> | null>(),
  citationsVerified: boolean('citations_verified'),
  sourceHash: text('source_hash'),
  taskId: uuid('task_id'),
  ...times
}, (table) => [index('note_versions_transcript_idx').on(table.transcriptId, table.createdAt)]);

export const summaryRequests = pgTable('summary_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  transcriptId: uuid('transcript_id').notNull().references(() => transcripts.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  inputHash: text('input_hash').notNull(),
  inputVersion: integer('input_version').notNull(),
  provider: text('provider').notNull(),
  template: text('template').notNull(),
  quoteSeconds: integer('quote_seconds').notNull().default(0),
  status: text('status').notNull(),
  noteEpoch: integer('note_epoch').notNull().default(0),
  outputMarkdown: text('output_markdown'),
  outputCitationHashes: jsonb('output_citation_hashes').$type<Record<string, string> | null>(),
  outputLanguage: text('output_language'),
  outputModel: text('output_model'),
  outputSavedAt: timestamp('output_saved_at', { withTimezone: true }),
  ...times
}, (table) => [uniqueIndex('summary_requests_user_key_unique').on(table.userId, table.idempotencyKey)]);

export const supportRequests = pgTable('support_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  category: text('category').notNull(),
  body: text('body').notNull(),
  sessionId: uuid('session_id'),
  status: text('status').notNull().default('open'),
  resolution: text('resolution'),
  diagnostics: jsonb('diagnostics').$type<Record<string, string>>(),
  ...times,
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => [index('support_requests_status_idx').on(table.status, table.createdAt)]);

export const productEvents = pgTable('product_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  source: text('source').notNull().default('server'),
  props: jsonb('props').$type<Record<string, string | number | boolean | null>>().notNull().default(sql`'{}'::jsonb`),
  ...times
}, (table) => [
  uniqueIndex('product_events_dedupe_unique').on(table.dedupeKey),
  index('product_events_name_created_idx').on(table.name, table.createdAt)
]);

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

/* user_id is cleared when the account is deleted so the fingerprint still
   points at its device ids. Otherwise an admin release could not lift the dev: claim. */
export const userDevices = pgTable('user_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  fingerprintHash: text('fingerprint_hash').notNull(),
  deviceId: text('device_id').notNull(),
  lastIp: text('last_ip'),
  userAgent: text('user_agent'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex('user_devices_user_fp_device_unique').on(table.userId, table.fingerprintHash, table.deviceId),
  index('user_devices_fingerprint_hash_idx').on(table.fingerprintHash),
  index('user_devices_device_id_idx').on(table.deviceId)
]);

/* claimed_by is intentionally not a foreign key. Deleting the account that used
   the free quota must leave the claim in place, or the next signup on the same
   browser would get a fresh free allowance. */
export const deviceClaims = pgTable('device_claims', {
  key: text('key').primaryKey(),
  claimedBy: uuid('claimed_by').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true })
});

/* No foreign keys. Deleting an account must leave the invite identity in
   place, or the same inbox could register again and collect another reward. */
export const referrals = pgTable('referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  inviterId: uuid('inviter_id').notNull(),
  inviteeId: uuid('invitee_id'),
  inviteeEmailIdentity: text('invitee_email_identity').notNull(),
  status: text('status').notNull(),
  reason: text('reason'),
  signupIp: text('signup_ip'),
  fingerprintHash: text('fingerprint_hash'),
  deviceId: text('device_id'),
  weakDevice: boolean('weak_device').notNull().default(false),
  qualifiedSessionId: uuid('qualified_session_id'),
  inviteeGrantedSeconds: integer('invitee_granted_seconds').notNull().default(0),
  inviterGrantedSeconds: integer('inviter_granted_seconds').notNull().default(0),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...times
}, (table) => [
  uniqueIndex('referrals_invitee_email_identity_unique').on(table.inviteeEmailIdentity),
  uniqueIndex('referrals_invitee_id_unique').on(table.inviteeId).where(sql`${table.inviteeId} is not null`),
  index('referrals_inviter_created_idx').on(table.inviterId, table.createdAt)
]);

export const authIpLimits = pgTable('auth_ip_limits', {
  ip: text('ip').notNull(),
  purpose: text('purpose').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  hits: integer('hits').notNull()
}, (table) => [primaryKey({ columns: [table.ip, table.purpose] })]);

export const adminAudit = pgTable('admin_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').references(() => users.id),
  action: text('action').notNull(),
  targetUserId: uuid('target_user_id').references(() => users.id),
  payloadJson: jsonb('payload_json'),
  ...times
});
