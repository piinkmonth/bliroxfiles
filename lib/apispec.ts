import { API_ORIGIN, PUBLIC_ORIGIN, LIMITS as SIZE_LIMITS } from './config'
import { LIMITS as RATE_LIMITS } from './ratelimit'
import type { ApiScope } from './db'

/**
 * The public API, described once.
 *
 * This module is the single source of truth for the reference docs
 * (app/developers) and the machine-readable spec (GET /v1/openapi.json). The
 * endpoints below are the contract; if an endpoint changes, it changes here and
 * both surfaces follow. Nothing here is generated from the route handlers, so
 * keep it honest — it is what callers read.
 */

export const API_VERSION = '1.0.0'
export const API_BASE = API_ORIGIN

const MB = 1024 * 1024
export const ONESHOT_MB = Math.round(SIZE_LIMITS.apiOneShotBytes / MB)
export const MAX_CHUNK_MB = Math.round(SIZE_LIMITS.maxChunkBytes / MB)

/** Requests per hour per token, by bucket — read straight from the limiter. */
export const RATE = {
  read: RATE_LIMITS.apiRead.max,
  write: RATE_LIMITS.apiWrite.max,
  upload: RATE_LIMITS.apiUpload.max,
  chunk: RATE_LIMITS.apiChunk.max,
}

export interface ScopeInfo {
  id: ApiScope
  summary: string
}

export const SCOPES: ScopeInfo[] = [
  { id: 'read', summary: 'List and read files and folders, and download file bytes.' },
  { id: 'write', summary: 'Upload files, create folders, and edit metadata.' },
  { id: 'delete', summary: 'Delete files and folders.' },
]

export interface Field {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean'
  required?: boolean
  description: string
  enum?: string[]
  example?: string | number | boolean
}

export interface Endpoint {
  id: string
  group: string
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** OpenAPI-style path, e.g. /v1/files/{id}. */
  path: string
  scope: ApiScope | null
  summary: string
  description: string
  pathParams?: Field[]
  query?: Field[]
  headers?: Field[]
  /** application/json body fields. */
  body?: Field[]
  /** Non-JSON request body, for uploads. */
  rawBody?: { kind: 'binary' | 'multipart'; description: string }
  /** Human description of the success payload. */
  returns: string
  /** Illustrative request. */
  curl: string
  /** Illustrative success body. */
  responseJson?: string
}

export const GROUPS = ['Account', 'Files', 'Uploads', 'Folders'] as const

const H_AUTH = '-H "Authorization: Bearer $BLIROX_TOKEN"'

export const ENDPOINTS: Endpoint[] = [
  // ---- Account ------------------------------------------------------------
  {
    id: 'get-account',
    group: 'Account',
    method: 'GET',
    path: '/v1/account',
    scope: 'read',
    summary: 'Account summary',
    description: 'Your username, storage quota, bytes used, and file/folder counts.',
    returns: 'An `account` object with `username`, `quotaBytes`, `usedBytes`, `freeBytes`, `files`, and `folders`.',
    curl: `curl ${API_BASE}/v1/account ${H_AUTH}`,
    responseJson: `{
  "ok": true,
  "account": {
    "username": "ash",
    "quotaBytes": 53687091200,
    "usedBytes": 1048576,
    "freeBytes": 53686042624,
    "files": 12,
    "folders": 3
  }
}`,
  },

  // ---- Files --------------------------------------------------------------
  {
    id: 'list-files',
    group: 'Files',
    method: 'GET',
    path: '/v1/files',
    scope: 'read',
    summary: 'List files',
    description:
      'Your files, newest first. Paginates by opaque cursor: pass the `nextCursor` from one page as `cursor` to fetch the next. Scope to a folder with `folder`.',
    query: [
      { name: 'limit', type: 'integer', description: 'Page size, 1–200 (default 50).', example: 50 },
      { name: 'cursor', type: 'string', description: 'Opaque cursor from a prior response.' },
      { name: 'folder', type: 'string', description: 'Folder id, or "root" for the top level. Omit for all folders.' },
    ],
    returns: 'A `files` array of file objects and a `nextCursor` (null on the last page).',
    curl: `curl "${API_BASE}/v1/files?limit=50" ${H_AUTH}`,
    responseJson: `{
  "ok": true,
  "files": [ { "id": "…", "name": "swap.img", "sizeBytes": 1073741824, "…": "…" } ],
  "nextCursor": "MTcw…"
}`,
  },
  {
    id: 'upload-file',
    group: 'Files',
    method: 'POST',
    path: '/v1/files',
    scope: 'write',
    summary: 'Upload a file (one-shot)',
    description: `Upload a file in a single request, up to ${ONESHOT_MB} MB. Send the raw bytes with an \`X-Filename\` header, or a \`multipart/form-data\` form with a \`file\` field. Larger files use the chunked flow (POST /v1/uploads). Options ride as query parameters (raw body) or form fields (multipart). Cannot target encrypted folders.`,
    headers: [
      { name: 'X-Filename', type: 'string', description: 'URL-encoded filename (raw-body uploads).' },
      { name: 'Content-Type', type: 'string', description: 'The file\'s media type. Ignored for multipart.' },
    ],
    query: [
      { name: 'folder', type: 'string', description: 'Destination folder id.' },
      { name: 'visibility', type: 'string', enum: ['unlisted', 'private'], description: 'Default unlisted.' },
      { name: 'note', type: 'string', description: 'Short description shown on the share page.' },
      { name: 'expiresIn', type: 'integer', description: 'Seconds until the share link expires.' },
      { name: 'burnAfter', type: 'integer', description: 'Delete the file after this many downloads.' },
      { name: 'anonymous', type: 'boolean', description: 'Hide the uploader on the share page.' },
    ],
    rawBody: { kind: 'binary', description: 'The file bytes.' },
    returns: 'The created `file` object (HTTP 201). `duplicate` is true if an identical file already existed.',
    curl: `curl -X POST "${API_BASE}/v1/files?visibility=private" \\
  ${H_AUTH} \\
  -H "X-Filename: swap.img" \\
  --data-binary @swap.img`,
    responseJson: `{ "ok": true, "file": { "id": "…", "name": "swap.img", "…": "…" }, "duplicate": false }`,
  },
  {
    id: 'get-file',
    group: 'Files',
    method: 'GET',
    path: '/v1/files/{id}',
    scope: 'read',
    summary: 'Get file metadata',
    description: 'Metadata, share URL, and download stats for one file you own.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'File id.' }],
    returns: 'A `file` object.',
    curl: `curl ${API_BASE}/v1/files/FILE_ID ${H_AUTH}`,
  },
  {
    id: 'download-file',
    group: 'Files',
    method: 'GET',
    path: '/v1/files/{id}/content',
    scope: 'read',
    summary: 'Download file bytes',
    description:
      'Stream the raw bytes of a file you own. Supports `Range` for resumable or partial reads. This is an owner read: it does not spend a burn-after budget. Encrypted files cannot be downloaded through the API.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'File id.' }],
    headers: [{ name: 'Range', type: 'string', description: 'Byte range, e.g. `bytes=0-1048575`.' }],
    returns: 'The file bytes (200, or 206 for a range request).',
    curl: `curl ${API_BASE}/v1/files/FILE_ID/content \\
  ${H_AUTH} \\
  -H "Range: bytes=0-1048575" -o slice.bin`,
  },
  {
    id: 'update-file',
    group: 'Files',
    method: 'PATCH',
    path: '/v1/files/{id}',
    scope: 'write',
    summary: 'Edit file metadata',
    description: 'Rename, move, or change sharing settings. Send only the fields you want to change.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'File id.' }],
    body: [
      { name: 'name', type: 'string', description: 'New display name.' },
      { name: 'visibility', type: 'string', enum: ['unlisted', 'private'], description: 'Share link on or off.' },
      { name: 'folderId', type: 'string', description: 'Move to this folder, or null for the top level.' },
      { name: 'sharePassword', type: 'string', description: 'Set a share password (min 6 chars), or null to remove.' },
      { name: 'anonymous', type: 'boolean', description: 'Hide the uploader on the share page.' },
      { name: 'expiresAt', type: 'integer', description: 'Epoch-ms expiry, or null for never.' },
      { name: 'burnAfter', type: 'integer', description: 'Downloads before self-delete, or null for no limit.' },
      { name: 'note', type: 'string', description: 'Share-page note, or null to clear.' },
    ],
    returns: 'The updated `file` object.',
    curl: `curl -X PATCH ${API_BASE}/v1/files/FILE_ID \\
  ${H_AUTH} -H "Content-Type: application/json" \\
  -d '{"name":"backup.img","visibility":"private"}'`,
  },
  {
    id: 'delete-file',
    group: 'Files',
    method: 'DELETE',
    path: '/v1/files/{id}',
    scope: 'delete',
    summary: 'Delete a file',
    description: 'Delete a file and reclaim its quota. Files under review cannot be deleted.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'File id.' }],
    returns: '`{ "deleted": true }`.',
    curl: `curl -X DELETE ${API_BASE}/v1/files/FILE_ID ${H_AUTH}`,
  },

  // ---- Uploads (chunked) --------------------------------------------------
  {
    id: 'create-upload',
    group: 'Uploads',
    method: 'POST',
    path: '/v1/uploads',
    scope: 'write',
    summary: 'Start a chunked upload',
    description:
      'Open an upload session for a large file. Declare the total size up front; the response tells you the chunk size and count. Then PUT each chunk and POST to complete. Cannot target encrypted folders.',
    body: [
      { name: 'filename', type: 'string', required: true, description: 'Display name.' },
      { name: 'sizeBytes', type: 'integer', required: true, description: 'Total file size in bytes.' },
      { name: 'mime', type: 'string', description: 'Media type.' },
      { name: 'folderId', type: 'string', description: 'Destination folder id.' },
    ],
    returns: 'An `uploadId`, `chunkBytes`, `totalChunks`, `maxChunkBytes`, and `expiresAt`.',
    curl: `curl -X POST ${API_BASE}/v1/uploads \\
  ${H_AUTH} -H "Content-Type: application/json" \\
  -d '{"filename":"disk.img","sizeBytes":10737418240}'`,
    responseJson: `{ "ok": true, "uploadId": "…", "chunkBytes": 67108864, "totalChunks": 160, "expiresAt": 1712345678000 }`,
  },
  {
    id: 'get-upload',
    group: 'Uploads',
    method: 'GET',
    path: '/v1/uploads/{id}',
    scope: 'read',
    summary: 'Upload status',
    description: 'Session progress. The `missing` array lists chunk indices still needed — resend only those to resume.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Upload session id.' }],
    returns: 'An `upload` object with `receivedChunks`, `totalChunks`, `missing`, and `status`.',
    curl: `curl ${API_BASE}/v1/uploads/UPLOAD_ID ${H_AUTH}`,
  },
  {
    id: 'put-chunk',
    group: 'Uploads',
    method: 'PUT',
    path: '/v1/uploads/{id}/chunks/{index}',
    scope: 'write',
    summary: 'Upload a chunk',
    description:
      'Send one chunk. Every chunk is `chunkBytes` long except the last, which is the remainder. Re-sending a chunk that already landed is a no-op, so retries are safe.',
    pathParams: [
      { name: 'id', type: 'string', required: true, description: 'Upload session id.' },
      { name: 'index', type: 'integer', required: true, description: 'Zero-based chunk index.' },
    ],
    rawBody: { kind: 'binary', description: 'The chunk bytes.' },
    returns: 'Progress: `received`, `totalChunks`, and `complete`.',
    curl: `curl -X PUT ${API_BASE}/v1/uploads/UPLOAD_ID/chunks/0 \\
  ${H_AUTH} \\
  --data-binary @chunk0.bin`,
  },
  {
    id: 'complete-upload',
    group: 'Uploads',
    method: 'POST',
    path: '/v1/uploads/{id}/complete',
    scope: 'write',
    summary: 'Finish a chunked upload',
    description:
      'Assemble the chunks, screen the result, and publish it. An optional JSON body sets the same creation options as the one-shot upload. Fails if chunks are still missing.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Upload session id.' }],
    body: [
      { name: 'visibility', type: 'string', enum: ['unlisted', 'private'], description: 'Default unlisted.' },
      { name: 'note', type: 'string', description: 'Share-page note.' },
      { name: 'expiresIn', type: 'integer', description: 'Seconds until the share link expires.' },
      { name: 'burnAfter', type: 'integer', description: 'Delete after this many downloads.' },
      { name: 'anonymous', type: 'boolean', description: 'Hide the uploader.' },
    ],
    returns: 'The created `file` object (HTTP 201).',
    curl: `curl -X POST ${API_BASE}/v1/uploads/UPLOAD_ID/complete \\
  ${H_AUTH} -H "Content-Type: application/json" \\
  -d '{"visibility":"private"}'`,
  },
  {
    id: 'abort-upload',
    group: 'Uploads',
    method: 'DELETE',
    path: '/v1/uploads/{id}',
    scope: 'write',
    summary: 'Abort an upload',
    description: 'Abandon a session and free its staged bytes immediately.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Upload session id.' }],
    returns: '`{ "aborted": true }`.',
    curl: `curl -X DELETE ${API_BASE}/v1/uploads/UPLOAD_ID ${H_AUTH}`,
  },

  // ---- Folders ------------------------------------------------------------
  {
    id: 'list-folders',
    group: 'Folders',
    method: 'GET',
    path: '/v1/folders',
    scope: 'read',
    summary: 'List folders',
    description: 'Folders directly under `parent`, or the top level. Encrypted folders are not returned.',
    query: [{ name: 'parent', type: 'string', description: 'Parent folder id, or "root". Omit for the top level.' }],
    returns: 'A `folders` array.',
    curl: `curl ${API_BASE}/v1/folders ${H_AUTH}`,
  },
  {
    id: 'create-folder',
    group: 'Folders',
    method: 'POST',
    path: '/v1/folders',
    scope: 'write',
    summary: 'Create a folder',
    description: 'Create a plain folder, optionally under a parent.',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Folder name.' },
      { name: 'parentId', type: 'string', description: 'Parent folder id.' },
    ],
    returns: 'The created `folder` object (HTTP 201).',
    curl: `curl -X POST ${API_BASE}/v1/folders \\
  ${H_AUTH} -H "Content-Type: application/json" \\
  -d '{"name":"backups"}'`,
  },
  {
    id: 'get-folder',
    group: 'Folders',
    method: 'GET',
    path: '/v1/folders/{id}',
    scope: 'read',
    summary: 'Get a folder',
    description: 'Metadata for one folder you own.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Folder id.' }],
    returns: 'A `folder` object.',
    curl: `curl ${API_BASE}/v1/folders/FOLDER_ID ${H_AUTH}`,
  },
  {
    id: 'update-folder',
    group: 'Folders',
    method: 'PATCH',
    path: '/v1/folders/{id}',
    scope: 'write',
    summary: 'Rename or move a folder',
    description: 'Send `name` to rename, `parentId` to move (null for the top level).',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Folder id.' }],
    body: [
      { name: 'name', type: 'string', description: 'New name.' },
      { name: 'parentId', type: 'string', description: 'New parent id, or null for the top level.' },
    ],
    returns: 'The updated `folder` object.',
    curl: `curl -X PATCH ${API_BASE}/v1/folders/FOLDER_ID \\
  ${H_AUTH} -H "Content-Type: application/json" \\
  -d '{"name":"archive"}'`,
  },
  {
    id: 'delete-folder',
    group: 'Folders',
    method: 'DELETE',
    path: '/v1/folders/{id}',
    scope: 'delete',
    summary: 'Delete a folder',
    description: 'Delete a folder. Files inside are lifted to the parent, not deleted. Pass `recursive=1` to remove subfolders too.',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Folder id.' }],
    query: [{ name: 'recursive', type: 'boolean', description: 'Also delete subfolders.' }],
    returns: '`{ "deleted": true }`.',
    curl: `curl -X DELETE "${API_BASE}/v1/folders/FOLDER_ID?recursive=1" ${H_AUTH}`,
  },
]

// ---------------------------------------------------------------------------
// OpenAPI 3.1 generation
//
// Mechanical projection of the endpoints above into an OpenAPI document, served
// at GET /v1/openapi.json. Kept deliberately simple: the endpoint list is the
// source, this just reshapes it.
// ---------------------------------------------------------------------------

function schemaForField(f: Field) {
  const s: Record<string, unknown> = { type: f.type, description: f.description }
  if (f.enum) s.enum = f.enum
  if (f.example !== undefined) s.example = f.example
  return s
}

function paramsFor(list: Field[] | undefined, where: 'path' | 'query' | 'header') {
  return (list ?? []).map((f) => ({
    name: f.name,
    in: where,
    required: where === 'path' ? true : !!f.required,
    description: f.description,
    schema: schemaForField({ ...f, description: '' }),
  }))
}

function requestBodyFor(e: Endpoint) {
  if (e.body && e.body.length) {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const f of e.body) {
      properties[f.name] = schemaForField(f)
      if (f.required) required.push(f.name)
    }
    return {
      required: required.length > 0,
      content: {
        'application/json': {
          schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        },
      },
    }
  }
  if (e.rawBody) {
    const media = e.rawBody.kind === 'multipart' ? 'multipart/form-data' : 'application/octet-stream'
    const schema =
      e.rawBody.kind === 'multipart'
        ? { type: 'object', properties: { file: { type: 'string', format: 'binary' } } }
        : { type: 'string', format: 'binary' }
    return { required: true, content: { [media]: { schema, description: e.rawBody.description } } }
  }
  return undefined
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const e of ENDPOINTS) {
    const op: Record<string, unknown> = {
      operationId: e.id,
      summary: e.summary,
      description: e.description,
      tags: [e.group],
      security: e.scope ? [{ bearerAuth: [] }] : [],
      parameters: [
        ...paramsFor(e.pathParams, 'path'),
        ...paramsFor(e.query, 'query'),
        ...paramsFor(e.headers, 'header'),
      ],
      responses: {
        '200': { description: e.returns },
        '400': { description: 'Bad request', content: errorContent() },
        '401': { description: 'Missing or invalid token', content: errorContent() },
        '403': { description: 'Token lacks the required scope', content: errorContent() },
        '404': { description: 'Not found', content: errorContent() },
        '429': { description: 'Rate limited', content: errorContent() },
      },
    }
    const rb = requestBodyFor(e)
    if (rb) op.requestBody = rb

    const key = e.path
    paths[key] = paths[key] ?? {}
    paths[key][e.method.toLowerCase()] = op
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Blirox API',
      version: API_VERSION,
      description: `Programmatic access to your Blirox files and folders. Authenticate with a bearer token created in Settings. Base URL: ${API_BASE}`,
    },
    servers: [{ url: API_BASE }, { url: `${PUBLIC_ORIGIN}/api` }],
    security: [{ bearerAuth: [] }],
    tags: GROUPS.map((g) => ({ name: g })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A blx_ token from Settings → API tokens.' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { ok: { type: 'boolean', example: false }, error: { type: 'string' } },
          required: ['ok', 'error'],
        },
      },
    },
  }
}

function errorContent() {
  return { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
}
