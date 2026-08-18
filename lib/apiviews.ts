import { type FileRow, type FolderRow, type ApiTokenRow, type ApiScope } from './db'
import { PUBLIC_ORIGIN, API_ORIGIN } from './config'
import { parseScopes } from './apitokens'
/**
 * The shapes the public API hands back.
 *
 * Kept in one place so every endpoint that returns a file or a folder returns
 * the *same* object — the reference docs and the OpenAPI spec describe these
 * fields, and a field that only some endpoints include is a field a client
 * cannot rely on. Names are camelCase (the API's convention) rather than the
 * snake_case the database uses, and nothing derived from a password hash or an
 * internal storage path is ever exposed.
 */

export interface FileView {
  id: string
  name: string
  sizeBytes: number
  mime: string | null
  sha256: string
  visibility: 'unlisted' | 'private'
  status: string
  folderId: string | null
  note: string | null
  anonymous: boolean
  encrypted: boolean
  passwordProtected: boolean
  downloads: number
  bytesServed: number
  burnAfter: number | null
  expiresAt: number | null
  createdAt: number
  /** Public share page. */
  url: string
  /** Authenticated byte stream for the owner (supports Range). */
  contentUrl: string
}

export function fileView(f: FileRow): FileView {
  return {
    id: f.id,
    name: f.name,
    sizeBytes: f.size_bytes,
    mime: f.mime,
    sha256: f.sha256,
    visibility: f.visibility,
    status: f.status,
    folderId: f.folder_id,
    note: f.note,
    anonymous: !!f.anonymous,
    encrypted: !!f.encrypted,
    passwordProtected: !!f.password_hash,
    downloads: f.downloads,
    bytesServed: f.bytes_served,
    burnAfter: f.burn_after,
    expiresAt: f.expires_at,
    createdAt: f.created_at,
    url: `${PUBLIC_ORIGIN}/f/${f.slug}`,
    contentUrl: `${API_ORIGIN}/v1/files/${f.id}/content`,
  }
}

export interface FolderView {
  id: string
  name: string
  parentId: string | null
  createdAt: number
}

export function folderView(f: FolderRow): FolderView {
  return {
    id: f.id,
    name: f.name,
    parentId: f.parent_id,
    createdAt: f.created_at,
  }
}

export interface TokenView {
  id: string
  name: string
  /** First 12 chars of the token (e.g. `blx_ab12cd34`) — safe to show. */
  prefix: string
  scopes: ApiScope[]
  lastUsedAt: number | null
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
}

/**
 * A token as shown in Settings. The hash and the (encrypted) last-used IP never
 * leave the server — this is the shape both the token API and the settings page
 * hand to the client.
 */
export function tokenView(t: ApiTokenRow): TokenView {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: [...parseScopes(t.scopes)],
    lastUsedAt: t.last_used_at,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
  }
}
