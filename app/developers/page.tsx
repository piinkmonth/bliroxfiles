import type { Metadata } from 'next'
import { Wordmark } from '@/components/Logo'
import { ThemePicker } from '@/components/ThemePicker'
import { Background } from '@/components/Background'
import { PUBLIC_ORIGIN, LIMITS } from '@/lib/config'
import { formatBytes } from '@/lib/format'
import {
  ENDPOINTS,
  GROUPS,
  SCOPES,
  RATE,
  API_BASE,
  API_VERSION,
  ONESHOT_MB,
  type Endpoint,
  type Field,
} from '@/lib/apispec'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Blirox API',
  description: 'Programmatic access to your Blirox files and folders.',
}

const SETTINGS_URL = `${PUBLIC_ORIGIN}/settings`

/** Verb → badge tint. Reads at a glance in the reference. */
const METHOD_BADGE: Record<Endpoint['method'], string> = {
  GET: 'badge-accent',
  POST: 'badge-success',
  PUT: 'badge-success',
  PATCH: 'badge-warn',
  DELETE: 'badge-danger',
}

/** Render `backtick` spans in a string as inline code, nothing else. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') ? (
          <code
            key={i}
            className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em] text-text"
          >
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

function Code({ children }: { children: string }) {
  return (
    <div className="overflow-x-auto rounded border border-border bg-bg/60">
      <pre className="p-3 font-mono text-xs leading-relaxed text-text">{children}</pre>
    </div>
  )
}

function ParamTable({ title, fields }: { title: string; fields: Field[] }) {
  return (
    <div>
      <div className="label">{title}</div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <tbody>
            {fields.map((f) => (
              <tr key={f.name} className="border-b border-border last:border-0 align-top">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-text">{f.name}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-muted">{f.type}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  {f.required ? (
                    <span className="text-accent">required</span>
                  ) : (
                    <span className="text-muted">optional</span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted">
                  <Inline text={f.description} />
                  {f.enum && (
                    <span className="ml-1 font-mono text-[0.85em] text-text">
                      ({f.enum.join(' | ')})
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EndpointCard({ e }: { e: Endpoint }) {
  return (
    <article id={e.id} className="card-solid scroll-mt-6 overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <span className={METHOD_BADGE[e.method]}>{e.method}</span>
        <code className="font-mono text-sm text-text">{e.path}</code>
        <span className="ml-auto flex items-center gap-2">
          {e.scope ? (
            <span className="chip">scope: {e.scope}</span>
          ) : (
            <span className="chip">public</span>
          )}
        </span>
      </header>

      <div className="space-y-4 px-5 py-4">
        <p className="text-sm leading-relaxed text-muted">
          <Inline text={e.description} />
        </p>

        {e.pathParams && <ParamTable title="Path" fields={e.pathParams} />}
        {e.query && <ParamTable title="Query" fields={e.query} />}
        {e.headers && <ParamTable title="Headers" fields={e.headers} />}
        {e.body && <ParamTable title="Body (JSON)" fields={e.body} />}
        {e.rawBody && (
          <p className="text-xs text-muted">
            <span className="kbd">body</span>{' '}
            <Inline text={e.rawBody.description} />{' '}
            {e.rawBody.kind === 'multipart'
              ? '(multipart/form-data)'
              : '(raw, application/octet-stream)'}
          </p>
        )}

        <div>
          <div className="label">Example</div>
          <Code>{e.curl}</Code>
        </div>

        {e.responseJson && (
          <div>
            <div className="label">Response</div>
            <Code>{e.responseJson}</Code>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted">
          <span className="text-text">Returns</span> <Inline text={e.returns} />
        </p>
      </div>
    </article>
  )
}

/** Small labelled section wrapper with a stable anchor. */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="display text-lg text-text">{title}</h2>
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  )
}

export default function DevelopersPage() {
  const quickstart = `# Create a token in Settings, then:
export BLIROX_TOKEN="blx_…"

# Who am I / how much room is left
curl ${API_BASE}/v1/account -H "Authorization: Bearer $BLIROX_TOKEN"

# Host a swapfile (one-shot, up to ${ONESHOT_MB} MB)
curl -X POST "${API_BASE}/v1/files?visibility=private" \\
  -H "Authorization: Bearer $BLIROX_TOKEN" \\
  -H "X-Filename: swap.img" \\
  --data-binary @swap.img`

  const errorShape = `{
  "ok": false,
  "error": "This token lacks the 'write' scope"
}`

  return (
    <>
      <Background />

      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="flex items-center gap-4">
          <a href={PUBLIC_ORIGIN} className="transition-opacity hover:opacity-80">
            <Wordmark />
          </a>
          <span className="chip">API v{API_VERSION}</span>
          <div className="ml-auto flex items-center gap-3">
            <a href={SETTINGS_URL} className="btn-ghost btn-sm">
              Get a token
            </a>
            <ThemePicker compact />
          </div>
        </header>

        {/* Intro ---------------------------------------------------------- */}
        <div className="mt-14 max-w-2xl">
          <h1 className="display text-3xl text-text">Blirox API</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Drive your account as remote storage — upload, list, download, and organise files over
            HTTP. Everything the web app does with your own files, a script can do too.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs text-muted">
            <span>
              <span className="text-text">base</span> {API_BASE}
            </span>
            <span>
              <span className="text-text">spec</span>{' '}
              <a href="/v1/openapi.json" className="text-accent hover:underline">
                /v1/openapi.json
              </a>
            </span>
          </div>
        </div>

        {/* Body grid ------------------------------------------------------ */}
        <div className="mt-14 lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-12">
          {/* Sidebar */}
          <nav className="hidden lg:block">
            <div className="sticky top-8 space-y-5 text-sm">
              <ul className="space-y-1.5">
                {[
                  ['auth', 'Authentication'],
                  ['scopes', 'Scopes'],
                  ['limits', 'Rate limits'],
                  ['errors', 'Errors'],
                  ['pagination', 'Pagination'],
                  ['quickstart', 'Quickstart'],
                ].map(([id, label]) => (
                  <li key={id}>
                    <a href={`#${id}`} className="text-muted transition-colors hover:text-accent">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>

              {GROUPS.map((g) => (
                <div key={g}>
                  <a
                    href={`#grp-${g}`}
                    className="display text-xs uppercase tracking-wide text-muted hover:text-accent"
                  >
                    {g}
                  </a>
                  <ul className="mt-1.5 space-y-1">
                    {ENDPOINTS.filter((e) => e.group === g).map((e) => (
                      <li key={e.id}>
                        <a
                          href={`#${e.id}`}
                          className="block text-xs text-muted transition-colors hover:text-accent"
                        >
                          {e.summary}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </nav>

          {/* Content */}
          <div className="mt-10 space-y-12 lg:mt-0">
            <Section id="auth" title="Authentication">
              <p className="text-sm leading-relaxed text-muted">
                Create a token under{' '}
                <a href={SETTINGS_URL} className="text-accent hover:underline">
                  Settings → API tokens
                </a>
                . It is shown once. Send it as a bearer token on every request:
              </p>
              <Code>{`Authorization: Bearer blx_…`}</Code>
              <p className="text-xs leading-relaxed text-muted">
                Tokens carry scopes and never expire unless you set an expiry. Store them like a
                password — anyone holding one has whatever access its scopes allow.
              </p>
            </Section>

            <Section id="scopes" title="Scopes">
              <p className="text-sm leading-relaxed text-muted">
                A token grants only the scopes you pick. A request needing a scope the token lacks
                is rejected with <span className="kbd">403</span>.
              </p>
              <div className="space-y-2">
                {SCOPES.map((s) => (
                  <div key={s.id} className="flex items-baseline gap-3 text-sm">
                    <span className="chip w-20 justify-center">{s.id}</span>
                    <span className="text-muted">{s.summary}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="limits" title="Rate limits">
              <p className="text-sm leading-relaxed text-muted">
                Limits are per token, per hour. Over the limit returns{' '}
                <span className="kbd">429</span> with a <span className="kbd">Retry-After</span>{' '}
                header.
              </p>
              <div className="overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-left text-xs">
                  <tbody>
                    {[
                      ['read', RATE.read, 'GET requests'],
                      ['write', RATE.write, 'Metadata edits, folder ops, upload init/complete'],
                      ['upload', RATE.upload, 'One-shot uploads, session start/finish'],
                      ['chunk', RATE.chunk, 'Chunk PUTs (generous for large files)'],
                    ].map(([bucket, max, note]) => (
                      <tr key={bucket as string} className="border-b border-border last:border-0">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-text">
                          {bucket as string}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-muted">
                          {(max as number).toLocaleString()}/hr
                        </td>
                        <td className="px-3 py-2 text-muted">{note as string}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section id="errors" title="Errors">
              <p className="text-sm leading-relaxed text-muted">
                Every error is JSON with the same shape and a matching HTTP status —{' '}
                <span className="kbd">400</span> bad request, <span className="kbd">401</span> no
                token, <span className="kbd">403</span> wrong scope,{' '}
                <span className="kbd">404</span> not found, <span className="kbd">429</span> rate
                limited.
              </p>
              <Code>{errorShape}</Code>
            </Section>

            <Section id="pagination" title="Pagination">
              <p className="text-sm leading-relaxed text-muted">
                List endpoints return a <span className="kbd">nextCursor</span>. Pass it back as{' '}
                <span className="kbd">cursor</span> for the next page; a null cursor means the last
                page. Cursors are opaque — do not build them yourself.
              </p>
            </Section>

            <Section id="quickstart" title="Quickstart">
              <Code>{quickstart}</Code>
              <p className="text-xs leading-relaxed text-muted">
                Files over {ONESHOT_MB} MB use the chunked flow: start a session, PUT each chunk,
                then complete. Chunked uploads scale to {formatBytes(LIMITS.maxFileBytes)}.
              </p>
            </Section>

            {/* Reference -------------------------------------------------- */}
            <section id="reference" className="scroll-mt-6">
              <h2 className="display text-lg text-text">Reference</h2>
              <div className="mt-4 space-y-10">
                {GROUPS.map((g) => (
                  <div key={g} id={`grp-${g}`} className="scroll-mt-6 space-y-4">
                    <h3 className="display text-sm uppercase tracking-wide text-muted">{g}</h3>
                    {ENDPOINTS.filter((e) => e.group === g).map((e) => (
                      <EndpointCard key={e.id} e={e} />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>

        <footer className="mt-20 border-t border-border pt-6 font-mono text-[11px] leading-relaxed text-muted">
          <p>
            The API reaches only your own plain files and folders. End-to-end encrypted folders are
            never exposed — the server cannot read them.
          </p>
        </footer>
      </div>
    </>
  )
}
