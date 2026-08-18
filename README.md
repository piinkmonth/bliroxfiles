# Blirox Files

> backstory: basically ran blirox files thru a tunnel for like a bit, but running thru a tunnel aka cloudflared 
> makes it very slow, or slow at startup then speeds up, but if your gonna host a file hosting service
> probably should have around a 1Gbps connection, now this can be fully hosted on a VPS, which is reccomended
> but not, because storage limits, but you can connect a NAS to this and it should work fine :)
> anyway, for any help you can join the blirox.cc discord, and check out other services @ https://blirox.cc -> https://discord.gg/dQY9ySFmJH

# another thing

using this project please credit me or my github, that would be so amazing if you did <3

# what is in here?

> well this is the same build used in my production build, so nothing really changes, except the secrets arent on the github build, you need that yourself
> anything in here was completely made by me :) ; and contributors, if they exist

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

  so with this, it chunks uploads, and has limits from 15GB/file in any accounts, and resumes around 64mb chunks (dont quote me on this)
  sharing;
  - can share stuff like encrypted folders, it decrypts within the browser
  - folders, galleries, and per-folder collabs
  - image and video previews

**end-to-end encryption**
- encrypted folders; files are encrypted in the browser with a passphrase before
  they ever leave your machine (AES-GCM, PBKDF2-SHA256, 600k iterations)
- the server only ever sees ciphertext for those

**accounts + access**
- invite-only registration with a full accountability chain (every account
  records who vouched for it by username that signed up)
- google sign-in (optional), TOTP 2FA, and a proper session model
- per-account quotas with deliberate overcommit
[google sign in requires you to make a google cloud project i think? idk i forgot >.<]

**running it sanely**
- a shared egress budget so one big download can't saturate your home uplink (this was entirely tested with 750Mbps, behind CGNAT)
- a hard "refuse to boot if the uploads drive isn't mounted" safety check
- an admin panel: users, invites, moderation queue, audit log, egress charts,
  appearance/branding
- a developer API (v1) with an OpenAPI spec, served from its own hostname [https://api.blirox.cc -> same api as in here]

**abuse handling** — see [moderation](#moderation--the-legal-part). legality is probably something you should read for your own sake

---

## how it works!

it's one Next.js app. there's no separate backend [though if your smart enough, host a node of it], no microservices and no queue

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

 -one note is like IDK if cloudflared still has this limit, i assumed they did when making this, so dont quote me on this either- :D

**downloads share an egress budget, they aren't capped per-download.** on a home
connection bandwidth is the real constraint, not disk. `lib/egress.ts` hands out
a shared budget so one person alone gets the whole pipe, and eight split it —
instead of the naive "cap each download and let concurrency multiply it" that
gets both cases wrong. there's a per-IP daily cap on top

**file bytes are served from their own hostname** (`us01.example.com`), split
from the app host (`files.example.com`). two reasons: you can move file serving
off cloudflare later without breaking share links already out (cloudflare's ToS
§2.8 frowns on bulk non-HTML through the CDN), and user content gets served with
a locked-down sandbox CSP so it can never run as the app.

**the developer API rides the same process** on a third hostname
(`api.example.com`). Next rewrites (`next.config.js`) route that host to
`/api/v1/*` and the docs page so there is no duplicate server.

if you read one file to understand the shape of things, read
[lib/config.ts](lib/config.ts). it's the central config and the comments there
explain most of the tradeoffs . . .

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
git clone [https://github.com/piinkmonth/bliroxfiles](https://github.com/piinkmonth/bliroxfiles.git)
cd blirox-files
npm install
npm run dev
```

that's it. it comes up on <http://localhost:4001> against a throwaway database in
`.devdata/`, with the mounted-drive safety check bypassed for you. nothing's
reachable from outside and nothing you do here touches a real drive.

make yourself an account (there's no open signup):

```bash
node scripts/create-admin.mjs putyourusernamehere
```

it'll prompt for a password. sign in, and you're an admin; invites, moderation,
appearance, all of it instantly

---

## going live

the full walkthrough — mounting the drive, env, the systemd unit, cloudflare
tunnel routes, google sign-in, malware scanning, the stuff that'll bite you in the ass is
in **[SETUP.md](SETUP.md)**. read it in order; every step needs **sudo** so none of
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

- **invite-only.** well yes
- **end-to-end encryption** for encrypted folders — AES-GCM with a
  PBKDF2-SHA256-derived key (600k iters), done in the browser, the server stores
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

none of this is exotic. it's mostly about being careful with the boring parts because if you dont read it ur cooked bruh

---

## moderation + the legal part

if you run a file host that other people can upload to, you will eventually host
something you have a legal obligation to deal with. this ships with the tooling
to handle that, but the tooling **tracks** your responsibilities — it doesn't
discharge them.

when reporting is done on a file for CSAM, it is taken very seriously, so just know that
usually a report shows up in the panel, you DO have to review it yourself unless you have a algorithm to auto-review

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
.env.example    every config var, documented # MAKE SURE TO CHANGE THIS TO .env.production WHEN YOU FINISH IT
```

---

## license

https://github.com/piinkmonth/bliroxfiles/tree/main#GPL-3.0-1-ov-file
