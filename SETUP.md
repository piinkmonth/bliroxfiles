# Blirox Files — setup

everything here needs sudo, so none of it is done for you. work through it in
order when you're ready to go live.

out of the box the app runs on `localhost:4001` against a throwaway db in
`.devdata/`. nothing's reachable from outside.

---

## 1. mount the uploads drive

pick the drive uploads live on and mount it at `/mnt/blirox-files` (or wherever
`BLIROX_STORAGE_ROOT` points). get its UUID with `blkid`, then wire up fstab so
the mount survives a reboot:

```bash
echo 'UUID=YOUR_DRIVE_UUID  /mnt/blirox-files  ext4  defaults,noatime  0  2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a          # no output = the entry's valid
```

use the UUID, not `/dev/sdb1` — device names reorder between boots, and the
wrong disk mounting at that path is a genuinely bad day.

> if the drive already holds other stuff, put uploads in a subdir (e.g.
> `/mnt/blirox-files/BliroxUpload`) instead of scattering `blobs/`, `db/`,
> `staging/` across the drive root. point `BLIROX_STORAGE_ROOT` at that subdir.

**the app refuses to start if the drive isnt mounted.** thats deliberate:
`/mnt/blirox-files` exists as an ordinary dir whether or not a drive is mounted
on it, so uploads would quietly fill the root filesystem til the OS died.
`lib/config.ts` compares the storage root's device against `/` and hard-fails if
they match. do NOT "fix" that with `BLIROX_ALLOW_UNMOUNTED=1` — that override is
for dev on a machine with no second disk, and setting it on the server defeats
the check entirely.

---

## 2. point the app at the real drive

`.env.local` is for local testing. for going live, create `.env.production`
(copy `.env.example` and fill it in):

```bash
BLIROX_STORAGE_ROOT=/mnt/blirox-files/BliroxUpload
BLIROX_PUBLIC_ORIGIN=https://files.example.com
BLIROX_CDN_ORIGIN=https://us01.example.com
BLIROX_APP_HOST=files.example.com
BLIROX_CDN_HOSTS=us01.example.com

# dev api + docs, served from its own host by the same process
BLIROX_API_HOST=api.example.com
BLIROX_API_ORIGIN=https://api.example.com

BLIROX_DEFAULT_QUOTA_GB=45
BLIROX_MAX_FILE_GB=15
BLIROX_CHUNK_MB=64

# egress — the one to tune, see "bandwidth" below
BLIROX_EGRESS_BUDGET_KBPS=9000
BLIROX_DOWNLOAD_KBPS=9000
BLIROX_MAX_CONCURRENT_DOWNLOADS=8
```

then delete `.env.local` (its `localhost` origins would end up in share links)
and rebuild:

```bash
npm run build
```

---

## 3. create the first admin

theres no open signup, so this is the only way to get an account:

```bash
node scripts/create-admin.mjs <username> [email]
```

it prompts for a password twice, no echo. sign in, then generate invites from
`/admin/invites`.

---

## 4. cloudflare tunnel routes

add these to the `ingress:` list in `/etc/cloudflared/config.yml`, **above** the
`- service: http_status:404` catch-all (order matters — first match wins, and
the catch-all matches everything). see `deploy/cloudflared-config.yml` for the
full template:

```yaml
  - hostname: files.example.com
    service: http://localhost:4001
  - hostname: us01.example.com
    service: http://localhost:4001
  - hostname: api.example.com
    service: http://localhost:4001
```

then create the DNS records and restart:

```bash
cloudflared tunnel route dns YOUR_TUNNEL_ID files.example.com
cloudflared tunnel route dns YOUR_TUNNEL_ID us01.example.com
cloudflared tunnel route dns YOUR_TUNNEL_ID api.example.com

sudo cloudflared tunnel ingress validate      # catches yaml mistakes
sudo systemctl restart cloudflared
```

any other tunnel routes you already have are untouched by this.

---

## 5. run it as a service

`/etc/systemd/system/blirox-files.service`:

```ini
[Unit]
Description=Blirox Files
After=network.target
# without this the app can start before the drive's mounted and hard-fail
RequiresMountsFor=/mnt/blirox-files

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/BliroxUpload
Environment=NODE_ENV=production
ExecStart=/usr/bin/npx next start -p 4001
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blirox-files
sudo systemctl status blirox-files
```

### google sign-in (optional, wired up + ready)

gives verified email addresses without running a mail server, and kills the
password-reset problem entirely.

**1. create the credentials** at <https://console.cloud.google.com/apis/credentials>

- new project (or reuse one) → **create credentials → OAuth client ID**
- application type: **web application**
- authorised redirect URI — must match *exactly*, scheme + path included:
  ```
  https://files.example.com/api/auth/google/callback
  ```
  add `http://localhost:4001/api/auth/google/callback` too if you want it
  working locally. google allows `http` for `localhost` only.

**2. configure the consent screen.** for a private service set publishing status
to **testing** and add the handful of people who need it as test users — that
skips google's verification review entirely. testing mode caps you at 100 users,
which is way beyond what a home-server disk supports anyway.

scopes: `openid`, `email`, `profile`. nothing sensitive, so no review.

**3. set the env vars** — in `.env.local` (dev) or `.env.production` (live),
**never in this file**. SETUP.md ends up in git; a committed client secret has
to be rotated, not deleted.

paste the values *without* the angle brackets — copying `<like-this>` from a
placeholder is the most common cause of google's unhelpful `invalid_client`
error. (the loader strips them defensively now, but it warns when it has to.)

```bash
BLIROX_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
BLIROX_GOOGLE_CLIENT_SECRET=GOCSPX-YOUR_SECRET
# only needed if the callback host differs from BLIROX_PUBLIC_ORIGIN
# BLIROX_GOOGLE_REDIRECT_URI=https://files.example.com/api/auth/google/callback
```

the google button shows up on the sign-in + invite pages automatically once
these are set, and disappears if theyre removed. password accounts keep working
exactly as before.

#### how linking behaves, and why

google sign-in **never adopts an existing account by email match**. email here
is optional and self-asserted — nobody verifies it — so matching on one would
let somebody register an account claiming your address and inherit your account
the moment you signed in with google.

instead: sign in with your password, then connect google from `/settings`.
accounts *created* through an invite + google are linked from the start, and
their address is verified by google.

disconnecting google is refused unless a password is set, since it'd otherwise
leave the account permanently unreachable.

### malware scanning (optional, wired up + ready)

two independent signals. both off until configured, and uploads proceed
unscanned rather than silently claiming to have been checked.

**clamav — local, does the real work:**

```bash
sudo apt install clamav clamav-daemon
sudo systemctl stop clamav-freshclam && sudo freshclam   # first signature pull
sudo systemctl enable --now clamav-freshclam clamav-daemon
```

clamd listens on a unix socket by default. this integration speaks TCP, so
enable that in `/etc/clamav/clamd.conf`:

```
TCPSocket 3310
TCPAddr 127.0.0.1
```

then `sudo systemctl restart clamav-daemon` and set:

```bash
BLIROX_CLAMAV_ENABLED=1
BLIROX_CLAMAV_PORT=3310
BLIROX_CLAMAV_MAX_MB=512      # bigger files are hashed but not streamed
```

test with the EICAR string — a harmless file every AV detects:

```bash
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.txt
clamdscan /tmp/eicar.txt        # should report FOUND
```

uploading that file should then be refused with a malware detection.

**virustotal — hash lookup only:**

```bash
BLIROX_VIRUSTOTAL_KEY=your_key_here
```

only the SHA-256 is sent — never file content. free tier is 500 lookups/day,
4/min. action threshold is 3+ engines: single-vendor hits are overwhelmingly
false positives on installers, packers, game mods and cracked software, and
acting on one would make the service unusable.

a malware detection quarantines the file and blocklists its hash, but does
**not** auto-suspend the uploader — people share samples for legit reasons, and
an AV hit alone isnt proof of intent to distribute. those land in
`/admin/moderation` for you to judge.

### video posters (optional)

video links unfurl in discord without this — dimensions come from reading the
MP4 container directly, which is what a chat client needs to lay out a player.
what ffmpeg adds is the still frame shown before playback.

```bash
sudo apt install ffmpeg
sudo systemctl restart blirox-files    # availability is resolved once at startup
```

without it you'll see this once per boot, which is informational not a problem:

```
[media] ffmpeg not found — video posters disabled, dimensions from MP4 parsing
```

note WebM dimensions need ffmpeg: the built-in parser reads MP4 + MOV only, so a
WebM on a server without ffmpeg embeds as a link rather than a player. MP4 is the
overwhelming majority of what gets shared, hence the split.

### housekeeping timer

`POST /api/maintenance` sweeps abandoned upload staging dirs + expired sessions.
run it on a timer, not in-process — a timer survives the app crashing, which is
exactly when staging is most likely full of half-finished uploads. any admin
session cookie works; simplest is a small cron script that logs in and calls it
daily.

---

## the things that will actually bite you

### cloudflare caps request bodies at 100mb

this is why uploads are chunked. a 15gb file goes up as ~240 requests of 64mb
each, reassembled server-side. you cant raise this on any plan below enterprise
— its not a setting you missed. if a chunk ever fails with a 413 from cloudflare
rather than from the app, lower `BLIROX_CHUNK_MB`.

### cloudflare ToS §2.8

serving disproportionate non-HTML content (video, big archives) through
cloudflare's CDN is restricted below enterprise. a file host is exactly what
that clause is aimed at.

`us01.example.com` is split from the app host specifically so file bytes can
move off cloudflare later — a direct DNS record, a cheap VPS proxy (see
`deploy/VPS-SETUP.md`), a tailscale funnel — without breaking a single share
link already sent. if cloudflare ever gets in touch, thats the lever you pull.
downloads already go out with `Cache-Control: private, no-store` so their edge
isnt storing your users' files.

### bandwidth

the real constraint, more than disk. one person downloading a 15gb file at a
typical home upstream ties up your connection for **hours**.

egress is governed by a shared budget, not a per-download rate.
`BLIROX_EGRESS_BUDGET_KBPS` caps the total across everything in flight, and each
download runs at the smaller of its share of that and `BLIROX_DOWNLOAD_KBPS`. so
one person alone gets the whole budget, and eight split it.

the earlier design capped each download instead and let concurrency multiply it,
which got both cases wrong: a lone downloader held at 3 MB/s on an otherwise idle
link, while eight of them could demand 24 MB/s of an uplink nowhere near it.

set the budget from your measured upstream. **on wifi the tradeoff is sharper
than on ethernet** — the medium's half-duplex, so bytes served steal airtime
from uploads arriving rather than travelling on a separate path. `/admin` charts
daily egress; watch it for the first couple weeks.

### storage math

465 GB ÷ 45 GB = **10 accounts** at full allocation. quota is deliberately
overcommitted past that on the assumption most people wont fill it.

that holds until it doesnt. the admin overview shows the overcommit ratio + real
free space; below 20 GB free, uploads are refused regardless of what individual
accounts have left, and registration is refused below 25 GB.

### backgrounds

upload them in **admin → appearance**. they land in `backgrounds/` on the
uploads drive, re-encoded to WebP + capped at 4K, and appear immediately.

do **not** add them by copying files into `public/backgrounds/` on a running
server. next resolves `public/` from a manifest built at startup, so a file
dropped in there is listed by the admin page but 404s when a browser asks — a
broken thumbnail, or a blank background if it gets pinned. it appears to work in
dev only bc the dev server stats the dir per request. images already committed to
`public/backgrounds/` are fine (they were there at build time); they show a
padlock in the admin grid and can only be removed from the repo.

### `thumbs/` is disposable

preview images live in `thumbs/` alongside `blobs/`, created automatically on
first request. its derived data: deleting the whole dir frees space and costs
nothing but a one-off re-encode next time each file is viewed. first thing to
delete when the drive's tight, and the one dir that doesnt need to be in a
backup. nothing in there is uploader bytes — sharp re-encodes each preview to
WebP at 640px, which is also what strips EXIF, so a photo's GPS coords never
reach a link unfurler.

---

## safety obligations — read this part

the tooling here doesnt discharge your legal responsibilities. it tracks them.

- **reporting is mandatory, not optional.** as a US operator, 18 U.S.C. § 2258A
  requires you to report apparent CSAM to NCMEC's CyberTipline once you have
  actual knowledge. a report sitting unactioned in `/admin/moderation` is
  knowledge.

- **register as an Electronic Service Provider with NCMEC before you need to.**
  doing it for the first time mid-incident is significantly worse.
  <https://report.cybertip.org/>

- **quarantined content is preserved, not deleted.** § 2258A(h) requires holding
  the content + related data for 90 days after reporting. the purge job skips
  incidents still marked `pending` — the clock starts at submission, and an
  unsubmitted report has no clock. so unreported incidents hold disk space
  indefinitely. thats intentional pressure to actually file them.

- **dont open reported files to "verify" them.** act on the report and file with
  NCMEC. reviewing the content yourself is neither required nor safe.

- **the invite chain is your best tool.** every account records who vouched for
  it, and the moderation queue shows that chain. accounts dont appear from
  nowhere, and whoever invited a bad actor is answerable for it.

whats built: invite-only registration with a full accountability chain, a report
button on every file, a moderation queue that sorts CSAM above everything,
SHA-256 + perceptual-hash blocklisting so removed content cant be re-uploaded by
anyone, automatic uploader suspension on CSAM action, frozen evidence snapshots
that survive account deletion, an append-only audit log, and NCMEC submission
tracking with preservation deadlines.

whats not, and cant be from here: proactive scanning against NCMEC's actual hash
database. that needs an industry partnership (PhotoDNA or similar). the blocklist
here only catches content **you** have already actioned. cloudflare offers a free
CSAM scanning tool to domain owners thats worth looking into, though it works on
proxied content and may not see traffic through a tunnel.
