# moving off the cloudflare tunnel onto a VPS

uploads normally go `browser → cloudflare edge → QUIC tunnel → home:4001`. this
swaps the middle two hops for `browser → VPS nginx → tailscale → home:4001`.

**no app code changes.** the whole `files.example.com` hostname moves, so every
request stays same-origin and the session cookie, the CSP, and the CSRF origin
check all keep working untouched. nothing in `.env.production` changes either.

> an earlier plan used a separate `up01.example.com` for uploads only. doesnt
> work: the session cookie is `sameSite: 'lax'` + host-only, so a cross-origin
> PUT carries no cookie and every chunk 401s; and `connect-src 'self'` blocks the
> request before its even sent. making it work needs `SameSite=None` +
> `Domain=.example.com`, which throws away the first layer of CSRF defence to
> save a DNS record. move the whole host instead.

---

## what this fixes and doesnt

**fixes:** the QUIC tunnel bottleneck, cloudflare's 100mb body cap, the ToS §2.8
exposure on file serving, and — most importantly — the HTTP/2
single-connection problem. the uploader runs six parallel chunks, but cloudflare
serves the browser over HTTP/2 where all six multiplex onto one TCP connection
and share one congestion window. nginx here is deliberately HTTP/1.1, so those
six become six independent connections.

**doesnt fix:** the home wifi ceiling (~12 MB/s here). bytes still have to land
on the home box's disk, so no proxy pushes more than the link carries. expect
this to raise the *effective* rate toward that ceiling, not past it.

**doesnt fix:** the disk. a spinning drive does roughly 60gb of I/O per 15gb
upload — 15gb of chunks written, then `assembleChunks` reading 15gb while writing
15gb on the same head, then `sha256File` reading 15gb back. the assembly step
still costs 10-20 min of "verifying and assembling" *after* the progress bar
fills.

**doesnt fix downloads.** bytes still originate on the home box, and on wifi they
compete with uploads for airtime. see the `BLIROX_MAX_CONCURRENT_DOWNLOADS` note.

---

## the machines

| role | tailscale name | tailscale ip |
|---|---|---|
| home box, runs the app on `:4001` | home | `YOUR_HOME_TS_IP` |
| VPS, runs nginx | vps | `YOUR_VPS_TS_IP` |

things worth verifying up front, so theyre not open questions later:

- **the path is direct, not relayed.** `tailscale ping vps` should say
  `pong ... via [<ipv6>]:41641` — a direct path on the wireguard port, no DERP in
  the middle. if it says `via DERP`, the proxy will be slower than the tunnel it
  replaces.
- **no exit node is in use**, so the home box's own traffic isnt being funnelled
  through another machine.
- **the app answers on its tailscale address**: `curl http://YOUR_HOME_TS_IP:4001/`
  returns 200. `next start` binds `*:4001`, so nginx can reach it with no change
  to how the app launches.

### the home link is wifi, and thats a decision not an oversight

this deployment runs over wifi (measured ~97 Mbit/s / ~12 MB/s into the house),
with the gigabit NIC sitting unused. running on wifi is deliberate here; dont
"fix" it by assuming a cable was forgotten. everything below is designed around
that ~12 MB/s number, not the VPS's gigabit port.

two things easy to miss:

- **wifi is a shared half-duplex medium.** downloads + uploads contend for the
  same airtime, so egress directly steals throughput from ingress. with
  `BLIROX_DOWNLOAD_KBPS=3000` and `BLIROX_MAX_CONCURRENT_DOWNLOADS=8`, eight
  active downloads want 24 MB/s — double the link — and starve uploads completely
  while they run. on wifi those numbers want lowering, not raising.
- **the proxy's gain here is loss tolerance, not bandwidth.** one stream gets
  15-40 Mbit/s, four get ~97 aggregate. that gap is the whole reason this nginx
  config refuses to speak HTTP/2.

### measure before you trust the ceiling

the home box already runs an iperf3 server as a systemd unit (`iperf3.service`,
`*:5201`), so only the client side needs running:

```bash
# on the VPS
iperf3 -c YOUR_HOME_TS_IP -t 20 -P 4
```

expect this, not the VPS port speed, to be the practical ceiling: tailscale does
wireguard in userspace, which typically lands well under a gigabit. the VPS↔home
RTT (measured ~46ms here) is now inside the path of every chunk, which is why
`sysctl-99-blirox.conf` raises `tcp_rmem`/`tcp_wmem` — the common 6mb default is
marginal at that latency.

---

## 1. tailscale

get both machines on the same tailnet and confirm theyre talking directly (the
`tailscale ping` check above).

---

## 2. nginx on the VPS

**if the VPS runs fedora** (not debian) four things change from the usual nginx
recipe, and three fail silently or confusingly if skipped.

```bash
sudo dnf install -y nginx certbot python3-certbot-nginx
```

fedora has no `sites-available`/`sites-enabled`. its `nginx.conf` includes
`/etc/nginx/conf.d/*.conf`, so the config goes straight there:

```bash
# from the home box — note the vps ssh user differs from your home user
scp deploy/nginx-blirox-files.conf you@YOUR_VPS_PUBLIC_IP:/tmp/

# on the VPS — `cp`, NOT `mv`. see the selinux note below.
sudo cp /tmp/nginx-blirox-files.conf /etc/nginx/conf.d/blirox-files.conf
sudo chown root:root /etc/nginx/conf.d/blirox-files.conf
sudo restorecon -v /etc/nginx/conf.d/blirox-files.conf
sudo nginx -t
```

**use `cp`, not `mv`, and this isnt a style thing.** `mv` preserves the source
file's selinux context, so a config moved out of `/tmp` arrives labelled
`user_tmp_t` and the confined nginx service cant read it. `cp` applies the
destination dir's default label.

the failure mode is genuinely misleading: `sudo nginx -t` runs as root outside
selinux confinement, reads the file fine, reports success. but the running
service logs `[emerg] open() ... failed (13: Permission denied)` and never binds
the port — so `ss` shows port 80 only while every syntax check insists the
config's valid. `restorecon` above fixes it if you already used `mv`.

**selinux blocks nginx from making outbound connections by default.** without
this the config's valid, nginx starts happily, and every request returns 502 with
`Permission denied` in the error log — which reads like a tailscale or firewall
problem and is neither:

```bash
sudo setsebool -P httpd_can_network_connect 1
```

**firewalld blocks 80/443 by default:**

```bash
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

then start it:

```bash
sudo systemctl enable --now nginx
```

read the comment above the `listen` lines before tidying anything. the absence
of `http2` there is load-bearing.

---

## 3. DNS

point the app + cdn hostnames at the VPS's **public** IP with an **A record,
proxy disabled (grey cloud)**:

| name | type | value | proxy |
|---|---|---|---|
| `files` | A | `YOUR_VPS_PUBLIC_IP` | DNS only |
| `us01` | A | `YOUR_VPS_PUBLIC_IP` | DNS only |

if they were previously proxied CNAMEs to a tunnel, replace each one.

grey cloud isnt optional. leaving it orange keeps cloudflare in the path, which
reinstates HTTP/2 to the browser, the 100mb body cap, and §2.8 — every problem
this is meant to solve, plus a hop.

use the VPS's **public** address, not its tailscale one — the tailscale address
isnt reachable from the internet, and pointing DNS at it would take the site down
with no obvious cause.

> if the VPS isnt dedicated to this app (say another site also resolves there and
> falls through to nginx's default server), adding a `default_server` block would
> change what that other domain does. watch for that.

leave any other tunnel routes (e.g. a separate streaming service) alone — they
stay on the tunnel. wait for propagation before the next step:

```bash
dig +short files.example.com          # expect the VPS IP, not a CNAME
```

---

## 4. certificates — via DNS-01, and this ordering matters

**get the certs before DNS moves, not after.**

the obvious approach — flip DNS, then run `certbot --nginx` — leaves a window
where the VPS answers on 443 without a valid cert. not survivable here:
`next.config.js` sends `Strict-Transport-Security: max-age=63072000;
includeSubDomains`, so every browser thats previously loaded `files.example.com`
has pinned HTTPS for two years and will hard-fail rather than fall back. theres
also a chicken-and-egg problem regardless: `nginx -t` fails on the missing
`ssl_certificate` files, so nginx wont start to serve the HTTP-01 challenge in
the first place.

DNS-01 validates by writing a TXT record through your DNS provider's API, so no
traffic needs to reach the VPS and the cert exists before anything points at it.

**create a scoped API token** limited to editing DNS for your zone — not a global
key with full account access. for cloudflare: dashboard → api tokens → *edit zone
DNS* template → zone resources: your zone.

```bash
sudo dnf install -y python3-certbot-dns-cloudflare

sudo install -m 600 /dev/null /etc/letsencrypt/cloudflare.ini
sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null <<'EOF'
dns_cloudflare_api_token = PASTE_TOKEN_HERE
EOF

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d files.example.com -d us01.example.com -d api.example.com \
  --agree-tos -m YOUR_EMAIL --non-interactive
```

the `600` perms on the credentials file arent decoration — the token can rewrite
DNS for the whole zone. renewal is automatic and keeps working after DNS moves,
bc DNS-01 never depended on where the hostname pointed:

```bash
sudo systemctl enable --now certbot-renew.timer
sudo certbot renew --dry-run
```

---

## 5. kernel tuning, both machines

```bash
sudo cp deploy/sysctl-99-blirox.conf /etc/sysctl.d/99-blirox.conf
sudo sysctl --system

cat /proc/sys/net/core/rmem_max                  # 7500000, was 212992
cat /proc/sys/net/ipv4/tcp_congestion_control    # cubic
```

**do not enable BBR.** it was tried here and measured 36x the retransmissions for
identical throughput — see the comment block in `sysctl-99-blirox.conf`. if you
previously ran `modprobe tcp_bbr` and wrote `/etc/modules-load.d/bbr.conf`, undo
it:

```bash
sudo rm -f /etc/modules-load.d/bbr.conf
sudo sysctl -w net.ipv4.tcp_congestion_control=cubic
sudo sysctl -w net.core.default_qdisc=fq_codel
```

do this on the home box too even though the tunnel no longer serves
`files.example.com` — other tunnel routes still use it, and it stays as rollback.

---

## 6. lock down the home box

`next start` binds `*:4001`, so it listens on every interface including
tailscale. thats what makes this work, but it also means anything that can reach
the box on 4001 gets in. if that box has any port forwarding or a public address,
restrict 4001 to the tailscale interface:

```bash
sudo apt install -y ufw
sudo ufw allow in on tailscale0 to any port 4001
sudo ufw deny 4001
sudo ufw allow ssh          # do this BEFORE enabling, or you lock yourself out
sudo ufw enable
```

while youre there: if `iperf3.service` is listening on `*:5201`, an iperf3 server
open to the internet lets anyone consume your bandwidth on demand. it only exists
for testing, so once the measurements are done, turn it off:

```bash
sudo systemctl disable --now iperf3
```

---

## 7. leave the tunnel configured

do **not** delete the `files.example.com` / `us01.example.com` entries from
`/etc/cloudflared/config.yml`. DNS no longer points at them, so theyre inert —
and that makes rollback a DNS change rather than a rebuild.

---

## verifying it worked

```bash
# served by nginx not cloudflare: no cf-ray header, and HTTP/1.1
curl -sI https://files.example.com | grep -iE "^HTTP|server|cf-ray"
```

expect `HTTP/1.1 200`, `Server: nginx`, and **no** `cf-ray`. a `cf-ray` means the
record's still orange-clouded.

then upload a big file from a machine on a fast connection and watch the rate in
the UI. the number to watch is the *upload bar*, not total wall-clock — the
assembly spinner afterwards is the disk, and this change doesnt touch it.

---

## rolling back

point the two DNS records back at the tunnel CNAME, proxy enabled:

```
files  CNAME  YOUR_TUNNEL_ID.cfargotunnel.com  (proxied)
us01   CNAME  YOUR_TUNNEL_ID.cfargotunnel.com  (proxied)
```

cloudflared is still running with those ingress rules, so it starts serving again
as soon as DNS propagates. nothing else needs undoing.
