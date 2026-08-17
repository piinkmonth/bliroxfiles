# Before you continue
Blirox Upload is a non-profit project made by a solo developer from the US. You can use this project for whatever you want, as long as you credit the developer. By nonprofit: We (I) make zero money from this project, it is purely enjoyment. Blirox Files is also invite only, so if you decide to make it public, that is **FULLY ON YOU!** Blirox Files is not public because of the new day and age using low-level file services to host CSAM, as well as viruses and whatnot.

> One thing to note is I was very lazy. I did not write the docs below. That's all I can say, all code is by me and has been reviewed. Security updates to this repo are going to be committed whenever I fix something...

# Maintaining
If you decide to maintain this project, you should work on the security pretty frequently. I can provide semi-support for this project, like setting it up and understanding how some files function, but I cannot be your full developer for this project. You should also probably not host this through a tunnel, we only hosted the website through a tunnel, but using a real VPS to host the file uploading side.

# Blirox Files

a self-hosted file host you actually own. invite-only, end-to-end encryption for
the stuff that needs it, a real moderation + abuse story, and a developer API —
all running out of a single Next.js process against SQLite and a disk. built to
run on a box at home behind a cloudflare tunnel (or a cheap VPS), not a rack.

> heads up: this is my real deployment, opened up. it's opinionated and
> it's built around a home server on ethernet. that shapes a bunch of decisions
> (chunked uploads, a shared egress budget, HTTP/1.1-only proxying). where a
> choice looks weird, there's usually a comment explaining why

---

## table of contents

- [what you get](#what-you-get)
- [how it works](#how-it-works)
- [the stack](#the-stack)
- [quick start (local dev)](#quick-start-local-dev)
- [going live](#going-live)
- [configuration](#configuration)
- [the developer API](#the-developer-api)
- [security model](#security-model)
- [moderation + the legal part](#moderation--the-legal-part)
- [project layout](#project-layout)
- [contributing](#contributing)
- [license](#license)

---

## what you get

**uploading + sharing**
- chunked uploads that survive a flaky connection — a 15gb file goes up as ~240
  resumable 64mb chunks, reassembled + hashed server-side
- share links with optional password, expiry, and burn-after-N-downloads
- folders, galleries, and per-folder collaborators (viewer / contributor)
- image + video previews that unfurl properly in discord/slack (thumbnails are
  re-encoded by sharp, so they carry none of the original's metadata — no EXIF
  GPS leaking to a link unfurler)

**end-to-end encryption**
- encrypted folders: files are encrypted in the browser with a passphrase before
  they ever leave your machine (AES-GCM, PBKDF2-SHA256, 600k iterations)
- the server only ever sees ciphertext for those — decryption happens client-side

**accounts + access**
- invite-only registration with a full accountability chain (every account
  records who vouched for it)
- google sign-in (optional), TOTP 2FA, and a proper session model
- per-account quotas with deliberate overcommit

**running it sanely**
- a shared egress budget so one big download can't saturate your home uplink
- a hard "refuse to boot if the uploads drive isn't mounted" safety check
- an admin panel: users, invites, moderation queue, audit log, egress charts,
  appearance/branding
- a developer API (v1) with an OpenAPI spec, served from its own hostname

**abuse handling** — see [moderation](#moderation--the-legal-part). it's a real
system, not a checkbox.

---

## how it works

it's one Next.js app. there's no separate backend, no microservices, no queue.

```
                    ┌─────────────────────────────────────────┐
   browser ───────► │  Next.js app  (next start -p 4001)        │
                    │                                           │
                    │   app/          pages + route handlers    │
                    │   lib/          all the actual logic       │
                    │   SQLite  ◄──── metadata, users, audit    │
                    └───────┬───────────────────────────────────┘
                            │ reads/writes
                            ▼
                    ┌───────────────────────────────┐
                    │  the uploads drive             │
                    │   blobs/      finished files    │
                    │   staging/    in-flight chunks  │
                    │   thumbs/     derived previews   │
                    │   quarantine/ held for review   │
                    │   db/         the SQLite file    │
                    └───────────────────────────────┘
```

a few ideas do most of the work:

**everything lives on one disk, tracked in SQLite.** file bytes go in `blobs/`,
metadata goes in a SQLite db on the same drive. no s3, no external db. `lib/db.ts`
owns the schema; `lib/storage.ts` owns the bytes.

**uploads are chunked because cloudflare caps request bodies at 100mb.** the
client (`components/Uploader.tsx`) slices the file, PUTs each chunk, and the
server reassembles + SHA-256s the result on `complete`. this is also why the app
is happy behind a tunnel with a small body limit.

**downloads share an egress budget, they aren't capped per-download.** on a home
connection bandwidth is the real constraint, not disk. `lib/egress.ts` hands out
a shared budget so one person alone gets the whole pipe, and eight split it —
instead of the naive "cap each download and let concurrency multiply it" that
gets both cases wrong. there's a per-IP daily cap on top.

**file bytes are served from their own hostname** (`us01.example.com`), split
from the app host (`files.example.com`). two reasons: you can move file serving
off cloudflare later without breaking share links already out (cloudflare's ToS
§2.8 frowns on bulk non-HTML through the CDN), and user content gets served with
a locked-down sandbox CSP so it can never run as the app.

**the developer API rides the same process** on a third hostname
(`api.example.com`). Next rewrites (`next.config.js`) route that host to
`/api/v1/*` and the docs page — no duplicate server.

if you read one file to understand the shape of things, read
[lib/config.ts](lib/config.ts). it's the central config and the comments there
explain most of the tradeoffs.

---

## the stack

- **Next.js 14** (app router) + **React 18** + **TypeScript**
- **better-sqlite3** — synchronous, single-file, plenty fast for this
- **sharp** — image re-encode + thumbnails (also how EXIF gets stripped)
- **tailwind** for styling, **lucide-react** for icons
- crypto is the platform's own **Web Crypto** / node `crypto` — no roll-your-own
- runs on **node 18+**

---

## quick start (local dev)

```bash
git clone <this repo>
cd blirox-files
npm install
npm run dev
```

that's it. it comes up on <http://localhost:4001> against a throwaway database in
`.devdata/`, with the mounted-drive safety check bypassed for you. nothing's
reachable from outside and nothing you do here touches a real drive.

make yourself an account (there's no open signup):

```bash
node scripts/create-admin.mjs <username>
```

it'll prompt for a password. sign in, and you're an admin — invites, moderation,
appearance, all of it.

---

## going live

the full walkthrough — mounting the drive, env, the systemd unit, cloudflare
tunnel routes, google sign-in, malware scanning, the stuff that'll bite you — is
in **[SETUP.md](SETUP.md)**. read it in order; every step needs sudo so none of
it happens by accident.

if you outgrow the cloudflare tunnel (the 100mb body cap, the HTTP/2
single-connection problem, or ToS §2.8), **[deploy/VPS-SETUP.md](deploy/VPS-SETUP.md)**
walks through moving file serving onto a cheap VPS reverse-proxy over tailscale
without breaking a single share link. the nginx config it uses lives in
[deploy/](deploy/) and its comments explain why it's HTTP/1.1-only and how the
`X-Forwarded-For` handling keeps the rate limiter honest.

the short version:

1. mount a drive, set `BLIROX_STORAGE_ROOT` to a path on it
2. `cp .env.example .env.production` and fill it in
3. `npm run build`
4. point three hostnames at the app (`files`, `us01`, `api`)
5. run it under systemd with `RequiresMountsFor` so it won't start before the
   drive mounts
6. `node scripts/create-admin.mjs you` and go

---

## configuration

everything is env vars, all prefixed `BLIROX_`. copy [.env.example](.env.example)
and fill it in — it's got a comment on every one. the ones that matter most:

| var | what it does |
|---|---|
| `BLIROX_STORAGE_ROOT` | where uploads live. must be on the mounted drive — the app refuses to boot if this lands on the same fs as `/` |
| `BLIROX_PUBLIC_ORIGIN` | the app's public url, used to build share links |
| `BLIROX_CDN_ORIGIN` / `BLIROX_CDN_HOSTS` | the hostname file bytes are served from |
| `BLIROX_API_HOST` / `BLIROX_API_ORIGIN` | the dev api + docs hostname |
| `BLIROX_DEFAULT_QUOTA_GB` | per-account space (overcommitted on purpose) |
| `BLIROX_MAX_FILE_GB` | biggest single upload |
| `BLIROX_CHUNK_MB` | upload chunk size — keep under cloudflare's 100mb cap |
| `BLIROX_EGRESS_BUDGET_KBPS` | **the throttle that matters.** total download bandwidth across everything at once. set it from your measured upstream |
| `BLIROX_DOWNLOAD_KBPS` | per-connection ceiling (not a fixed rate) |
| `BLIROX_ENCRYPTION_KEY` | encrypts stored IP addresses at rest. **back this up** — lose it and existing encrypted values are gone |
| `BLIROX_GOOGLE_CLIENT_ID` / `_SECRET` | google sign-in (optional) |
| `BLIROX_CLAMAV_ENABLED` / `BLIROX_VIRUSTOTAL_KEY` | malware scanning (optional) |

---

## the developer API

there's a versioned REST API at `/v1/*`, served from `api.example.com` (or
`files.example.com/api/v1/*` — same handlers). authenticate with a token you
generate in **settings → API tokens**.

- `GET /v1/account` — who am i, quota, usage
- `GET /v1/files` / `GET /v1/files/:id` — list + inspect
- `POST /v1/files` — one-shot upload (under the ~90mb one-shot cap)
- `POST /v1/uploads` + chunk endpoints — the chunked flow for big files
- `GET /v1/files/:id/content` — download bytes
- folders CRUD under `/v1/folders`

the full spec is generated as OpenAPI — hit `/openapi.json` on the api host, or
the human docs at the api host root. the generator lives in
[lib/apispec.ts](lib/apispec.ts).

---

## security model

the short tour (details are in the code comments, which is where they belong):

- **invite-only.** no open signup. every account records its inviter, so there's
  an accountability chain when something goes wrong.
- **end-to-end encryption** for encrypted folders — AES-GCM with a
  PBKDF2-SHA256-derived key (600k iters), done in the browser. the server stores
  ciphertext and never sees the passphrase.
- **2FA** via TOTP, and **google oauth** with a deliberate no-adopt-by-email
  rule (see SETUP.md for why matching on a self-asserted email would be a
  takeover vector).
- **stored IPs are encrypted at rest** with `BLIROX_ENCRYPTION_KEY`.
- **user content is sandboxed.** everything served from the byte host gets
  `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, and
  `?inline=1` only ever honours a strict raster/media allowlist — never SVG,
  HTML, or PDF. so an upload can't turn into a page running on your domain.
- **CSP, HSTS, frame-ancestors 'none'**, and friends on the app itself — see
  [next.config.js](next.config.js).
- **rate limiting + a per-IP daily egress cap**, both keyed on an IP the proxy
  layer is careful not to let clients forge (the nginx comments in
  [deploy/](deploy/) are load-bearing here).
- **CSRF** via origin checks + `sameSite` cookies.

none of this is exotic. it's mostly about being careful with the boring parts.

---

## moderation + the legal part

if you run a file host that other people can upload to, you will eventually host
something you have a legal obligation to deal with. this ships with the tooling
to handle that, but the tooling **tracks** your responsibilities — it doesn't
discharge them.

built in: a report button on every file, a moderation queue that sorts CSAM
above everything, SHA-256 + perceptual-hash blocklisting so removed content
can't be re-uploaded, automatic uploader suspension on CSAM action, frozen
evidence snapshots that survive account deletion, an append-only audit log, and
NCMEC submission tracking with the 90-day preservation clock.

**if you're a US operator, read the "safety obligations" section of
[SETUP.md](SETUP.md) before you go live.** 18 U.S.C. § 2258A makes reporting
apparent CSAM to NCMEC mandatory once you have actual knowledge — and a report
sitting unactioned in your moderation queue counts as knowledge. register as an
ESP with NCMEC *before* you need to, not mid-incident.

---

## project layout

```
app/            pages + API route handlers (Next app router)
  api/          all the server endpoints
    dl/         the byte-serving download route (sandboxed)
    v1/         the developer API
    ...
  dashboard/    the logged-in file/folder UI
  admin/        moderation, users, invites, audit, appearance
  f/  g/        public file + gallery share pages
lib/            the actual logic — config, db, storage, crypto, egress,
                uploads, moderation, auth, api, ...
components/     shared react components (uploader, media player, nav, ...)
scripts/        create-admin, the prod start wrapper
deploy/         nginx / cloudflared / sysctl templates + the VPS guide
SETUP.md        the going-live walkthrough
.env.example    every config var, documented
```

---

## contributing

the code comments are written the way the owner actually talks — lowercase,
casual, short, and honest about *why* something is the way it is rather than
restating what the code plainly does. if you send a PR, match that voice. there's
a short spec in [.notes-style.md](.notes-style.md) with the rules and examples.

the one hard rule: comments explain the *why* and flag the gotchas. security and
safety warnings keep their meaning — you can make a warning shorter, never
quieter.

---

## license

https://github.com/piinkmonth/bliroxfiles/tree/main#GPL-3.0-1-ov-file
