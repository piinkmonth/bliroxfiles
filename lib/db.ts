import Database from 'better-sqlite3'
import { PATHS, ensureStorageTree } from './config'
import { encrypt, encryptionAvailable } from './crypto'

let _db: Database.Database | null = null

export function db(): Database.Database {
  if (_db) return _db

  ensureStorageTree()

  const conn = new Database(PATHS.db)
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('busy_timeout = 5000')

  migrate(conn)
  _db = conn
  return conn
}

const SCHEMA = `
-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user',      -- user | mod | admin
  status         TEXT NOT NULL DEFAULT 'active',    -- active | suspended | banned
  quota_bytes    INTEGER NOT NULL,
  used_bytes     INTEGER NOT NULL DEFAULT 0,

  -- Accountability chain: every account traces back to whoever vouched for it.
  invited_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  invite_code    TEXT,

  signup_ip      TEXT,
  last_seen_at   INTEGER,
  created_at     INTEGER NOT NULL,
  suspended_at   INTEGER,
  suspend_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Invites — the only way an account comes into existence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  note         TEXT,                                -- "for dave", why it exists
  quota_bytes  INTEGER NOT NULL,
  max_uses     INTEGER NOT NULL DEFAULT 1,
  uses         INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(created_by);

-- ---------------------------------------------------------------------------
-- Folders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,   -- NULL = top level
  name       TEXT NOT NULL,

  /*
   * End-to-end encrypted folder. The key is derived client-side and never
   * reaches the server, so nothing here can be hash-checked, moderated or
   * preserved. That is exactly why encrypted folders are never shareable —
   * see lib/folders.ts. Storing only the KDF parameters, never the key.
   */
  encrypted     INTEGER NOT NULL DEFAULT 0,
  kdf_salt      TEXT,
  kdf_params    TEXT,
  verifier      TEXT,        -- proves a supplied password is right, reveals no key

  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- No duplicate names among siblings. Two indexes because SQLite treats NULLs
-- as distinct, so a single UNIQUE(owner, parent, name) would happily allow two
-- top-level folders both called "photos".
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_child
  ON folders(owner_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_root
  ON folders(owner_id, name) WHERE parent_id IS NULL;

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL UNIQUE,               -- public share id
  name          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  mime          TEXT,
  sha256        TEXT NOT NULL,
  phash         TEXT,                               -- perceptual hash, images only
  storage_path  TEXT NOT NULL,                      -- relative to PATHS.blobs

  visibility    TEXT NOT NULL DEFAULT 'unlisted',   -- unlisted | private
  password_hash TEXT,                               -- optional per-file password
  downloads     INTEGER NOT NULL DEFAULT 0,
  bytes_served  INTEGER NOT NULL DEFAULT 0,

  status        TEXT NOT NULL DEFAULT 'active',     -- active | quarantined | removed
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);

-- ---------------------------------------------------------------------------
-- Chunked upload sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_sessions (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  mime           TEXT,
  chunk_bytes    INTEGER NOT NULL,
  total_chunks   INTEGER NOT NULL,
  received_mask  BLOB NOT NULL,                     -- bitset, 1 bit per chunk
  received_count INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open',      -- open | assembling | done | failed
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_owner ON upload_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_uploads_expiry ON upload_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Abuse handling
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  file_id      TEXT REFERENCES files(id) ON DELETE CASCADE,
  reporter_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_ip  TEXT,                                -- anonymous reports allowed
  category     TEXT NOT NULL,                       -- csam | malware | copyright | other
  detail       TEXT,
  status       TEXT NOT NULL DEFAULT 'open',        -- open | actioned | dismissed
  priority     INTEGER NOT NULL DEFAULT 0,          -- csam auto-escalates to 100
  created_at   INTEGER NOT NULL,
  resolved_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  INTEGER,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_reports_file ON reports(file_id);

-- Content that may never be uploaded again, by anyone.
CREATE TABLE IF NOT EXISTS blocklist (
  id          TEXT PRIMARY KEY,
  sha256      TEXT,
  phash       TEXT,
  category    TEXT NOT NULL,                        -- csam | malware | copyright | other
  reason      TEXT,
  added_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocklist_sha ON blocklist(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocklist_phash ON blocklist(phash) WHERE phash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Incident records, structured for NCMEC CyberTipline reporting.
--
-- 18 U.S.C. § 2258A requires a US provider to report apparent CSAM to NCMEC
-- once it has actual knowledge, and § 2258A(h) requires preserving the content
-- and associated data for 90 days after reporting. Quarantined content is
-- therefore NOT deleted on sight — it is moved out of serving reach and held.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id              TEXT PRIMARY KEY,
  file_id         TEXT REFERENCES files(id) ON DELETE SET NULL,
  report_id       TEXT REFERENCES reports(id) ON DELETE SET NULL,
  uploader_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  category        TEXT NOT NULL,

  -- Snapshot taken at quarantine time; survives account/file deletion.
  evidence_json   TEXT NOT NULL,

  quarantine_path TEXT,
  preserve_until  INTEGER,                          -- created_at + 90 days
  ncmec_status    TEXT NOT NULL DEFAULT 'pending',  -- pending | submitted | n/a
  ncmec_report_id TEXT,
  ncmec_notes     TEXT,
  created_at      INTEGER NOT NULL,
  submitted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(ncmec_status);

-- ---------------------------------------------------------------------------
-- Append-only audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,
  actor_name  TEXT,                                 -- denormalised: survives deletion
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  ip          TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

-- ---------------------------------------------------------------------------
-- Bandwidth accounting — feeds the egress guard so the home link survives
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bandwidth_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,                        -- YYYY-MM-DD, local time
  file_id     TEXT,
  user_id     TEXT,
  ip          TEXT,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bw_day ON bandwidth_log(day);
CREATE INDEX IF NOT EXISTS idx_bw_ip_day ON bandwidth_log(ip, day);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Shared access to an encrypted folder
--
-- A row here grants a second account the right to *see* the folder and fetch
-- its ciphertext. It grants no ability to read anything: the key is derived
-- from the passphrase in the collaborator's own browser, and the passphrase is
-- passed between people out of band. The server therefore cannot read a shared
-- folder any more than it can read a private one, and revoking a collaborator
-- takes away reach, not knowledge — anyone who already had the passphrase and
-- a copy of the bytes keeps both.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS folder_collaborators (
  folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',      -- viewer | contributor
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (folder_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_collab_user ON folder_collaborators(user_id);

-- ---------------------------------------------------------------------------
-- Things the account holder needs told about, surfaced at their next sign-in.
--
-- A notice outlives the session it concerns, which is the whole point: the
-- geo guard destroys the session precisely so the holder cannot keep using it,
-- and there is then no session left to render a warning into.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                        -- session.geo_revoked | ...
  detail     TEXT,                                 -- JSON
  created_at INTEGER NOT NULL,
  seen_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notices_unseen ON security_notices(user_id, seen_at);

-- ---------------------------------------------------------------------------
-- API tokens: bearer credentials for the public API (api.example.com)
--
-- Stored hashed, never in the clear: a token ends up in scripts, shell history
-- and server logs, so a database leak must not hand over live credentials.
-- Same reasoning that keeps passwords and TOTP secrets out of plaintext.
-- The raw token is shown to its owner exactly once, at creation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                     -- owner's label, e.g. "backup script"
  prefix        TEXT NOT NULL,                     -- shown in the UI: blx_ab12cd34
  token_hash    TEXT NOT NULL UNIQUE,              -- sha256 of the full token
  scopes        TEXT NOT NULL,                     -- csv subset of read,write,delete
  last_used_at  INTEGER,
  last_used_ip  TEXT,                              -- encrypted, via clientIpForStorage()
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                           -- NULL = never
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
`

/**
 * Add a column only if it isn't already there.
 *
 * CREATE TABLE IF NOT EXISTS does nothing for a table that already exists, so
 * new columns need an explicit ALTER. SQLite has no ADD COLUMN IF NOT EXISTS,
 * hence the pragma check.
 */
function addColumnIfMissing(
  conn: Database.Database,
  table: string,
  column: string,
  definition: string,
) {
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (columns.some((c) => c.name === column)) return
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * One-off: encrypt audit-log IPs written before v8.
 *
 * Until v8 the audit trail took `clientIp()` directly, so it accumulated
 * plaintext addresses while every other table stored them under AES-GCM. The
 * column is now written encrypted, which leaves the historical rows as the only
 * plaintext personal data in the database — so they get converted in place.
 *
 * Guarded by a settings flag rather than by scanning: once done, the rows all
 * start with the `v1.` version prefix, and re-running would be a full table
 * scan on every boot for nothing.
 */
function encryptLegacyAuditIps(conn: Database.Database) {
  const done = conn
    .prepare(`SELECT value FROM settings WHERE key = 'audit_ips_encrypted'`)
    .get() as { value: string } | undefined
  if (done) return

  // No key configured means no way to convert them. Leave the rows alone and
  // do not set the flag, so this runs properly once a key exists.
  if (!encryptionAvailable()) return

  const rows = conn
    .prepare(`SELECT id, ip FROM audit_log WHERE ip IS NOT NULL AND ip NOT LIKE 'v1.%'`)
    .all() as { id: number; ip: string }[]

  const update = conn.prepare(`UPDATE audit_log SET ip = ? WHERE id = ?`)
  conn.transaction(() => {
    for (const r of rows) update.run(encrypt(r.ip), r.id)
    conn
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('audit_ips_encrypted', ?, ?)`)
      .run(String(rows.length), Date.now())
  })()

  if (rows.length > 0) {
    console.log(`[db] encrypted ${rows.length} legacy audit-log IP(s)`)
  }
}

function migrate(conn: Database.Database) {
  conn.exec(SCHEMA)

  // --- v2: profile pictures -------------------------------------------------
  addColumnIfMissing(conn, 'users', 'avatar_path', 'TEXT')
  addColumnIfMissing(conn, 'users', 'avatar_updated_at', 'INTEGER')
  addColumnIfMissing(conn, 'users', 'display_name', 'TEXT')
  addColumnIfMissing(conn, 'users', 'bio', 'TEXT')

  // --- v3: folders ----------------------------------------------------------
  // No FK on folder_id via ALTER (SQLite cannot add one to an existing table);
  // orphans are prevented in application code and swept by folder deletion.
  addColumnIfMissing(conn, 'files', 'folder_id', 'TEXT')
  // Client-side encryption metadata. Never the key itself.
  addColumnIfMissing(conn, 'files', 'encrypted', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(conn, 'files', 'enc_meta', 'TEXT')
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)`)
  // Destination is chosen at init and carried through to complete, so a file
  // lands in the folder the user picked even if they navigate away mid-upload.
  addColumnIfMissing(conn, 'upload_sessions', 'folder_id', 'TEXT')
  addColumnIfMissing(conn, 'upload_sessions', 'enc_meta', 'TEXT')

  // --- v4: upload origin, staff verification -------------------------------
  // Two-letter country from Cloudflare's CF-IPCountry, captured at init so it
  // reflects where the upload actually started rather than where it finished.
  addColumnIfMissing(conn, 'upload_sessions', 'country', 'TEXT')
  addColumnIfMissing(conn, 'files', 'country', 'TEXT')
  // Staff vouching that a file is what it claims to be.
  addColumnIfMissing(conn, 'files', 'verified_at', 'INTEGER')
  addColumnIfMissing(conn, 'files', 'verified_by', 'TEXT')
  addColumnIfMissing(conn, 'files', 'verified_note', 'TEXT')
  // Recorded scan verdict, so the admin panel can show what was checked.
  addColumnIfMissing(conn, 'files', 'scan_verdict', 'TEXT')
  addColumnIfMissing(conn, 'files', 'scan_detail', 'TEXT')

  // --- v5: Google sign-in ---------------------------------------------------
  // google_sub is Google's stable account identifier. Matching on it rather
  // than on email matters: people change their Gmail address, and an email
  // that changes hands must never inherit the old owner's account.
  addColumnIfMissing(conn, 'users', 'google_sub', 'TEXT')
  addColumnIfMissing(conn, 'users', 'google_email', 'TEXT')
  addColumnIfMissing(conn, 'users', 'google_linked_at', 'INTEGER')
  addColumnIfMissing(conn, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0')

  // --- v6: encrypted folder names -------------------------------------------
  // An encrypted folder stores its name as ciphertext, which is different on
  // every encryption of the same string. Sibling-name uniqueness therefore
  // cannot be enforced for them, so the indexes are narrowed to plain folders.
  conn.exec(`DROP INDEX IF EXISTS idx_folders_unique_child`)
  conn.exec(`DROP INDEX IF EXISTS idx_folders_unique_root`)
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_child
       ON folders(owner_id, parent_id, name) WHERE parent_id IS NOT NULL AND encrypted = 0`,
  )
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_root
       ON folders(owner_id, name) WHERE parent_id IS NULL AND encrypted = 0`,
  )

  // --- v7: two-factor auth, verified accounts, anonymous sharing ------------
  // The TOTP secret is stored encrypted: anyone who can read it can generate
  // valid codes forever, which makes it as sensitive as a password.
  addColumnIfMissing(conn, 'users', 'totp_secret', 'TEXT')
  addColumnIfMissing(conn, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(conn, 'users', 'totp_last_counter', 'INTEGER')
  addColumnIfMissing(conn, 'users', 'totp_backup_codes', 'TEXT')
  addColumnIfMissing(conn, 'users', 'totp_enabled_at', 'INTEGER')

  // Staff vouching for an account, shown as a check next to their name.
  addColumnIfMissing(conn, 'users', 'account_verified_at', 'INTEGER')
  addColumnIfMissing(conn, 'users', 'account_verified_by', 'TEXT')
  addColumnIfMissing(conn, 'users', 'account_verified_note', 'TEXT')

  // Hides the uploader on a file's public page.
  addColumnIfMissing(conn, 'files', 'anonymous', 'INTEGER NOT NULL DEFAULT 0')
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
       ON users(google_sub) WHERE google_sub IS NOT NULL`,
  )

  // --- v8: previews, shared encrypted folders, geo-aware sessions -----------

  // Generated preview images. `thumb_state` distinguishes "not tried yet" from
  // "tried and there is nothing to show", so a file that cannot be thumbnailed
  // is not re-decoded on every single page view.
  addColumnIfMissing(conn, 'files', 'thumb_path', 'TEXT')
  addColumnIfMissing(conn, 'files', 'thumb_state', 'TEXT') // pending | ready | none

  // Whether a share link may be handed out for a file in an encrypted folder.
  // Separate from `visibility` on purpose: visibility is about who the server
  // will serve bytes to, this is about whether the owner has opted into the
  // link existing at all, and the two are revoked independently.
  addColumnIfMissing(conn, 'files', 'enc_share', 'INTEGER NOT NULL DEFAULT 0')

  // Where a session was last seen. The geo guard compares against it.
  addColumnIfMissing(conn, 'sessions', 'country', 'TEXT')
  addColumnIfMissing(conn, 'users', 'geo_guard', 'INTEGER NOT NULL DEFAULT 1')

  // Country alongside the (encrypted) address, so the audit log can be read
  // without anything being decrypted. See the backfill below.
  addColumnIfMissing(conn, 'audit_log', 'country', 'TEXT')
  encryptLegacyAuditIps(conn)

  // --- v9: media metadata, notes, expiry, gallery links ---------------------

  // Probed once and stored, because a link unfurler needs the dimensions and
  // re-opening the container on every request to find them would be absurd.
  addColumnIfMissing(conn, 'files', 'media_width', 'INTEGER')
  addColumnIfMissing(conn, 'files', 'media_height', 'INTEGER')
  addColumnIfMissing(conn, 'files', 'media_duration', 'REAL')
  // 'probed' distinguishes "looked and found nothing" from "not looked at yet".
  addColumnIfMissing(conn, 'files', 'media_state', 'TEXT')

  // A short description from the uploader, shown on the share page and used as
  // the link-preview description in place of the generic size/type line.
  addColumnIfMissing(conn, 'files', 'note', 'TEXT')

  /*
   * Download budget. NULL means unlimited; a number is how many downloads the
   * link has left before the file destroys itself.
   *
   * Stored as a remaining count rather than a limit so the check is a single
   * atomic decrement, with no read-then-write window for two simultaneous
   * downloads to both slip through.
   */
  addColumnIfMissing(conn, 'files', 'burn_after', 'INTEGER')
  addColumnIfMissing(conn, 'files', 'burned_at', 'INTEGER')

  // Gallery links: one folder published as a single browsable page.
  addColumnIfMissing(conn, 'folders', 'share_token', 'TEXT')
  addColumnIfMissing(conn, 'folders', 'share_created_at', 'INTEGER')
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_share_token
       ON folders(share_token) WHERE share_token IS NOT NULL`,
  )

  // --- v10: API tokens ------------------------------------------------------
  // The api_tokens table is declared in SCHEMA (CREATE TABLE IF NOT EXISTS), so
  // conn.exec(SCHEMA) above creates it on an existing database too — no ALTER
  // needed for a brand-new table.

  const row = conn.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined

  const current = row ? Number(row.value) : 0
  if (current < SCHEMA_VERSION) {
    conn
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(String(SCHEMA_VERSION), Date.now())
  }
}

const SCHEMA_VERSION = 10

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type Role = 'user' | 'mod' | 'admin'
export type UserStatus = 'active' | 'suspended' | 'banned'
export type FileStatus = 'active' | 'quarantined' | 'removed'
export type ReportCategory = 'csam' | 'malware' | 'copyright' | 'other'
export type ApiScope = 'read' | 'write' | 'delete'

export interface UserRow {
  id: string
  username: string
  email: string | null
  password_hash: string
  role: Role
  status: UserStatus
  quota_bytes: number
  used_bytes: number
  invited_by: string | null
  invite_code: string | null
  signup_ip: string | null
  last_seen_at: number | null
  created_at: number
  suspended_at: number | null
  suspend_reason: string | null
  totp_secret: string | null
  totp_enabled: number
  totp_last_counter: number | null
  totp_backup_codes: string | null
  totp_enabled_at: number | null
  account_verified_at: number | null
  account_verified_by: string | null
  account_verified_note: string | null
  google_sub: string | null
  google_email: string | null
  google_linked_at: number | null
  email_verified: number
  avatar_path: string | null
  avatar_updated_at: number | null
  display_name: string | null
  bio: string | null
  geo_guard: number
}

export type CollaboratorRole = 'viewer' | 'contributor'

export interface CollaboratorRow {
  folder_id: string
  user_id: string
  role: CollaboratorRole
  invited_by: string | null
  created_at: number
}

export interface SecurityNoticeRow {
  id: number
  user_id: string
  kind: string
  detail: string | null
  created_at: number
  seen_at: number | null
}

export interface FolderRow {
  id: string
  owner_id: string
  parent_id: string | null
  name: string
  encrypted: number
  kdf_salt: string | null
  kdf_params: string | null
  verifier: string | null
  share_token: string | null
  share_created_at: number | null
  created_at: number
}

export interface FileRow {
  id: string
  owner_id: string
  anonymous: number
  country: string | null
  verified_at: number | null
  verified_by: string | null
  verified_note: string | null
  scan_verdict: string | null
  scan_detail: string | null
  folder_id: string | null
  encrypted: number
  enc_meta: string | null
  enc_share: number
  thumb_path: string | null
  thumb_state: 'pending' | 'ready' | 'none' | null
  media_width: number | null
  media_height: number | null
  media_duration: number | null
  media_state: 'probed' | null
  note: string | null
  /** Downloads remaining before the file self-destructs. NULL = unlimited. */
  burn_after: number | null
  burned_at: number | null
  slug: string
  name: string
  size_bytes: number
  mime: string | null
  sha256: string
  phash: string | null
  storage_path: string
  visibility: 'unlisted' | 'private'
  password_hash: string | null
  downloads: number
  bytes_served: number
  status: FileStatus
  created_at: number
  expires_at: number | null
  deleted_at: number | null
}

export interface UploadSessionRow {
  id: string
  owner_id: string
  country: string | null
  folder_id: string | null
  enc_meta: string | null
  filename: string
  size_bytes: number
  mime: string | null
  chunk_bytes: number
  total_chunks: number
  received_mask: Buffer
  received_count: number
  status: 'open' | 'assembling' | 'done' | 'failed'
  created_at: number
  updated_at: number
  expires_at: number
}

export interface InviteRow {
  code: string
  created_by: string | null
  note: string | null
  quota_bytes: number
  max_uses: number
  uses: number
  expires_at: number | null
  revoked_at: number | null
  created_at: number
}

export interface ApiTokenRow {
  id: string
  user_id: string
  name: string
  prefix: string
  token_hash: string
  scopes: string
  last_used_at: number | null
  last_used_ip: string | null
  created_at: number
  expires_at: number | null
  revoked_at: number | null
}
