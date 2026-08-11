# Self-Hosting Lurker

This guide walks through running your own Lurker server, from the first `docker compose up -d` through optional features like passkeys, push notifications, and exposing your instance to the internet over HTTPS.

If you just want the TL;DR, the [Quickstart](#quickstart) gets you a working instance on `http://localhost:8015` in two commands.

---

## Quickstart

You need Docker (with the Compose plugin). On a fresh machine:

```bash
curl -O https://raw.githubusercontent.com/amiantos/lurker/main/docker-compose.yml
docker compose up -d
```

That's it. Open <http://localhost:8015> in your browser and follow the first-run wizard to create your admin account (username + password). You're now connected to a Lurker server that will stay running across reboots; pair it with one or more IRC networks from the in-app settings.

All persistent state lives in a `./data/` directory next to your `docker-compose.yml` — back that up to back up Lurker.

## First-run wizard

The very first time you open the app it'll prompt you to create the initial admin user. You pick a username and a password (8+ characters). That user is automatically promoted to `admin`, which means they can:

- Invite additional users (each user gets their own IRC networks, history, and settings)
- Reset their own password from the settings panel
- Eventually manage the system from the admin panel

Lurker is multi-user — anyone you invite gets their own private set of networks. There is no public sign-up; new accounts can only be created through admin-issued invite links.

## Updating

```bash
docker compose pull
docker compose up -d
```

Run these from the directory holding your `docker-compose.yml`. If you used the [one-shot DigitalOcean deploy](digitalocean.md), that's `/opt/lurker` — `cd` there first; the command is identical whether or not you enabled HTTPS.

Lurker auto-migrates its SQLite schema on boot, so updates are a pull + restart. The `data/` directory is not touched.

If something goes wrong, your `data/` directory still has your last-known-good state — back it up before major updates if you want a clean rollback path.

## Backups

Everything Lurker persists lives in `./data/`:

- `lurker.db` (and `-shm`, `-wal` files) — IRC history, settings, users, etc.
- `session-secret.key` — the secret used to sign session cookies. Backing this up means existing browser sessions survive a restore.

A `cp -r data/ data-backup-$(date +%F)/` (with the server stopped, to avoid copying mid-write WAL files) is sufficient. If you need a hot copy, use the SQLite `.backup` command:

```bash
docker exec lurker sqlite3 /app/data/lurker.db ".backup '/app/data/lurker-snapshot.db'"
```

Then copy `data/lurker-snapshot.db` out.

---

## Exposing Lurker to the internet (recommended: Cloudflare Tunnel)

Lurker is a single-user-per-account always-on IRC client — most operators want to reach it from their phone or laptop while away from home. The simplest, most reliable way to do this is a **Cloudflare Tunnel** (`cloudflared`). You get:

- A public HTTPS URL on a domain you already own (terminated at Cloudflare's edge — no certificate management on your end)
- No port forwarding, no router configuration, no inbound firewall holes
- Works behind CGNAT, on a residential network, or anywhere with outbound HTTPS
- Free for personal use

> **Starting from a blank VPS?** If you don't already have a host, the [one-shot DigitalOcean deploy](digitalocean.md) brings up a fresh droplet with Lurker and automatic HTTPS (via Caddy) from a single pasted script — no SSH, no manual Docker install. The rest of this section covers exposing an instance you're already running.

### Setup

1. **Own a domain on Cloudflare.** You don't need to buy one through Cloudflare, but the DNS does need to be managed there. (Cloudflare's free plan is fine.)

2. **Create the tunnel** in the Cloudflare dashboard:
   - Go to **Zero Trust → Networks → Tunnels → Create a tunnel**, pick "Cloudflared", name it `lurker`, and copy the install command Cloudflare gives you. The command embeds a token tied to this tunnel.

3. **Add `cloudflared` to your `docker-compose.yml`** alongside Lurker:

   ```yaml
   services:
     lurker:
       # ... existing config ...

     cloudflared:
       image: cloudflare/cloudflared:latest
       container_name: lurker-tunnel
       restart: unless-stopped
       command: tunnel run
       environment:
         - TUNNEL_TOKEN=eyJ...your-token-here...
   ```

   Then `docker compose up -d`. The tunnel container will phone home to Cloudflare and stay connected.

4. **Route a hostname to Lurker.** Back in the Cloudflare dashboard, under your tunnel's "Public Hostname" tab, add:
   - **Subdomain**: `lurker` (or whatever you want)
   - **Domain**: pick one of your zones
   - **Service**: `http://lurker:8015` (the container talks to Lurker over Docker's internal network)

   Cloudflare provisions DNS automatically. Within a minute, `https://lurker.example.com` resolves and serves your Lurker instance over HTTPS.

5. **Update Lurker's environment** so passkeys and push notifications know about the public hostname (see [Optional features](#optional-features) below). At minimum, if you plan to enable passkeys:

   ```yaml
   environment:
     # ... existing config ...
     - WEBAUTHN_RP_ID=lurker.example.com
     - WEBAUTHN_RP_NAME=Lurker
     - WEBAUTHN_ORIGIN=https://lurker.example.com
   ```

   Then `docker compose up -d` to apply.

### Alternative: any reverse proxy

If you already run Caddy, Traefik, nginx, or another reverse proxy with an automatic-TLS story, point it at `http://localhost:8015` (or attach Lurker to your proxy network). For passkeys / push, the public origin must match `WEBAUTHN_ORIGIN`.

Two things the proxy **must** get right, because Lurker's live connection is a WebSocket:

1. **Forward the WebSocket upgrade.** The `/ws` endpoint needs the `Upgrade` and `Connection` headers passed through. Caddy and Traefik do this automatically. For nginx you have to add it explicitly (see below).
2. **Forward the browser's host** — either preserve the original `Host` header, or send `X-Forwarded-Host`. Lurker's WebSocket does a same-origin check on the upgrade (a CSRF protection against cross-site socket hijacking), comparing the browser's `Origin` against the host it sees. A proxy that rewrites `Host` to the upstream address (`127.0.0.1:8015`) breaks that match, and the socket is rejected with a `403`. Caddy and Traefik send `X-Forwarded-Host` by default; for nginx, set `Host` (shown below).

A minimal nginx `location` that satisfies both:

```nginx
location / {
    proxy_pass http://127.0.0.1:8015;
    proxy_set_header Host $http_host;         # same-origin WS check (see note)
    proxy_set_header Upgrade $http_upgrade;   # WebSocket upgrade
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Use `$http_host`, not `$host`, for the `Host` line: `$host` drops the port, so on a non-standard port the forwarded host (`irc.example.com`) won't match the browser's `Origin` (`irc.example.com:8443`) and the check still fails. `$http_host` forwards the host **and** port verbatim, so it's correct on any port. (On the standard 443 the two are equivalent.)

If you'd rather not (or can't) fix the forwarded host, set `CORS_ORIGIN` to your public origin as an explicit allowlist instead — e.g. `CORS_ORIGIN=https://irc.example.com`. It accepts a comma-separated list, and a trailing slash is tolerated, but the scheme, host, and port must otherwise match the address you load Lurker at exactly.

> **Upgraded to 1.1.1 and the connection stopped working?** This same-origin check is new in 1.1.1. If your reverse proxy rewrites `Host` and you don't set `CORS_ORIGIN`, the WebSocket now `403`s where it used to connect. Add `proxy_set_header Host $http_host;` (or `X-Forwarded-Host`), or set `CORS_ORIGIN`, per above.

---

## Optional features

### Passkeys (WebAuthn)

Lurker works fine with just username + password — passkeys are a quality-of-life addition (fingerprint / Face ID / hardware key login). (The [one-shot DigitalOcean deploy](digitalocean.md) sets these up for you.) To enable them elsewhere, set three environment variables that match the public origin your browsers actually hit:

```yaml
environment:
  - WEBAUTHN_RP_ID=lurker.example.com # hostname only, no scheme, no port
  - WEBAUTHN_RP_NAME=Lurker
  - WEBAUTHN_ORIGIN=https://lurker.example.com # full origin, scheme + port
```

`WEBAUTHN_ORIGIN` can be comma-separated if you log in from multiple URLs (e.g. a dev hostname and your public Cloudflare URL).

Restart Lurker, log in with your password, then visit **Settings → Passkeys** and register one. Passkeys require HTTPS for any non-localhost hostname — browsers won't allow the WebAuthn ceremony otherwise.

**Lost your passkey?** Just log in with your password and remove the dead passkey from the settings panel.

### Web Push notifications

Lurker supports background push notifications for highlights and DMs, delivered to your installed PWA even when the tab is closed. (The [one-shot DigitalOcean deploy](digitalocean.md) sets `VAPID_SUBJECT` for you.) To enable it elsewhere:

1. Set a valid `VAPID_SUBJECT` (the contact address embedded in outgoing push JWTs — APNs requires a real domain):

   ```yaml
   environment:
     - VAPID_SUBJECT=mailto:you@example.com
   ```

2. Restart Lurker. The first time the push service is used, it generates a VAPID keypair and stores it in `data/lurker.db` (under `app_meta`). The same keypair is reused on subsequent boots so existing subscriptions keep working.

3. From a browser (HTTPS required), open Lurker, "Install" it as a PWA, and enable notifications in the settings.

If you change `VAPID_SUBJECT` later, existing subscriptions continue to work — the subject only affects new push JWTs, not the keypair.

### Push and the mobile apps

**Short version: install Lurker as a home-screen PWA and use Web Push above. That is the supported path for a self-hosted server, and it works on iOS 16.4+ and Android with no developer account and no extra configuration.**

The first-party Lurker mobile apps use native push (APNs on iOS, FCM on Android), and a self-hosted server **cannot** deliver to them. This isn't a missing feature — it's how the platforms work:

- An APNs signing key only signs for the bundle id Apple issued it to.
- An FCM token is scoped to the Firebase project compiled into the APK; a token from a different project is rejected outright (`MismatchSenderId`).

So only the publisher of a build can push to that build. Supplying your own Apple or Google credentials to `LURKER_APNS_*` / `LURKER_FCM_SERVICE_ACCOUNT` will not make your server able to push to the App Store or Play Store app — those variables exist for whoever publishes the app, and for anyone running **their own build** of it signed with their own credentials.

You can check what a given server can actually deliver on: `GET /api/push/config` returns a `transports` list. A self-hosted server reports `["webpush"]`, and the apps use that to tell you push isn't available rather than asking for notification permission and then silently never delivering.

### File uploads on your own disk

By default, images you paste or drop into the message box are uploaded to a third-party host (x0.at). If you'd rather keep them on your own server, pick **local** in **Settings → Uploads**. Lurker then writes the file to disk and serves it back from your own instance, and the link it pastes into IRC points at you — no third party involved.

Files land in `uploads/` next to the SQLite database (so they're on your mounted volume and already covered by the [backup](#backups) advice above). Point them somewhere else with:

```yaml
environment:
  - LOCAL_UPLOADS_DIR=/data/uploads
```

The link Lurker pastes into IRC has to be an **absolute** URL, or nobody else can open it. Lurker works the origin out from the incoming request, which is right for most reverse-proxy setups. If your links come out with the wrong hostname or scheme, pin it explicitly:

```yaml
environment:
  - PUBLIC_BASE_URL=https://lurker.example.com
```

::: warning Cloudflare users: turn off Hotlink Protection
If you expose Lurker through Cloudflare (including a [Cloudflare Tunnel](#exposing-lurker-to-the-internet-recommended-cloudflare-tunnel)), **Hotlink Protection will break local uploads.** It's a Cloudflare feature that blocks image files whenever they're loaded from a page on another domain — which is exactly what an uploaded image _is_ once you share the link on IRC. Cloudflare returns a `403` at the edge and the request never reaches Lurker, so the image loads for you but is broken for everyone else.

Fix it in the Cloudflare dashboard under **Scrape Shield → Hotlink Protection → Off**. If you want to keep it on for the rest of your site, leave it enabled and add a **Configuration Rule** that turns it off just for your uploads:

- **When incoming requests match:** `URI Path` `starts with` `/uploads/`
- **Then the settings are:** `Hotlink Protection` → `Off`

If you set this rule up before Lurker 1.0 it will say `/uploads/local/`. Uploads now live directly under `/uploads/`, so widen it — the shorter prefix still matches the old links, which keep working.

See [Uploaded images are broken for other people](#uploaded-images-are-broken-for-other-people-403) if you've already hit this.
:::

### Link previews & inline media

Off by default. When enabled, a link pasted into chat can unfurl into a preview
card (title, description, image — the way Slack or Discord do it); a link
straight to an image renders inline; and a link to a **video or audio file**
renders a poster frame that plays in place when clicked.

It's off by default because it makes your deployment fetch third-party URLs that
appear in chat — a behavior an operator should choose, not inherit.

#### You run a second container: `lurker-previews`

All of the fetching and media parsing happens in a separate service,
[`lurker-previews`](https://github.com/amiantos/lurker-previews), not in the main
server. That split is the point: the main process holds your users' sessions and
your database, and it never dials a stranger's URL or runs an image/video decoder
(`sharp`, `ffmpeg`) on bytes someone pasted. The decoder does that, in a box built
to be thrown away if it's ever compromised.

**Setting `LURKER_PREVIEWS_URL` to point at a running decoder is the entire enable
switch** — there's no separate on/off flag. Add the service alongside Lurker:

```yaml
services:
  lurker:
    environment:
      - LURKER_PREVIEWS_URL=http://lurker-previews:8030
      # ...your other settings

  lurker-previews:
    image: ghcr.io/amiantos/lurker-previews:latest
    restart: unless-stopped
    # The decoder is meant to reach the public internet but nothing on your
    # private network. It proves that at boot and REFUSES TO START if it can
    # reach a private address — which, on a plain Docker network, it can (the
    # host is one hop away). For a home/VPS self-host, tell it to skip that
    # check: the in-process SSRF guard still refuses private URLs, so this is the
    # same protection the feature had before it was split out. See "Hardening"
    # below to enforce it at the network layer instead.
    environment:
      - LURKER_PREVIEWS_ALLOW_PRIVATE=1
      # Optional: what the decoder tells sites it is when it fetches a preview.
      # The default names Lurker and the traffic class (a social-preview fetch),
      # so an operator reading their logs can recognise and block it on purpose.
      # - LURKER_PREVIEW_USER_AGENT=
    # No ports published — only the Lurker container talks to it, over the
    # shared Docker network.
```

**Enabling the instance doesn't show anyone a preview yet.** The feature is
double-gated: each user also has two toggles in **Settings → Chat** — **Link
previews** and **Inline media** — both defaulting to off. Those toggles only
_appear_ once a decoder is configured, so if a user can't find the setting,
`LURKER_PREVIEWS_URL` is the reason.

The decoder identifies itself honestly in its User-Agent, guards every fetch
against SSRF (loopback, RFC-1918, link-local including cloud metadata, CGNAT and
IPv4-in-IPv6 all refused, with DNS pinned so the answer can't change between the
check and the connection), and proxies preview **images** back through your
Lurker server so users' browsers never touch the third-party host. A video or
audio clip is never relayed — only its poster frame is — so pressing play goes
straight to the origin, the one request the reader deliberately made.

#### Hardening: enforce the egress limit at the network layer

`LURKER_PREVIEWS_ALLOW_PRIVATE=1` turns off the decoder's boot self-test so it
runs on an ordinary Docker network. The in-process SSRF guard is still active, so
a malicious *URL* is refused either way — what you give up is protection against a
malicious *process* (an RCE in the decoder reaching your LAN). For a trusted
group that's a fair trade; to close it, drop the `ALLOW_PRIVATE` line and instead
firewall the decoder so it can reach the internet but not private ranges. On a
Linux host that's `DOCKER-USER` rules dropping traffic from the decoder's subnet
to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` and
`100.64.0.0/10`, plus an `INPUT` rule for the host itself. With those in place the
self-test passes and the container refuses to serve if they ever lapse. (This is
exactly what the hosted fleet does per-cell.)

#### Caching preview images (optional)

Without a cache this already works — the server just re-fetches an image when
nobody's browser has it cached. `LURKER_PREVIEW_CACHE_MODE` trades a little disk
or a bucket for not re-fetching popular images:

- **`off`** (default) — fetch through, store nothing.
- **`local`** — the sensible self-host choice. Cached bytes live in a directory
  next to the database (2 GiB cap by default, least-recently-used eviction).
  It's a cache, not data: safe to delete while the server is stopped.
- **`s3`** — for instances already running behind a CDN: cached images go to a
  bucket you own and get served from its **public** base URL, so your server
  ships zero bytes for an image it has already fetched. This one has real
  operational requirements — the objects are publicly readable, the base URL
  must be https, and **you** own eviction via a lifecycle rule on the bucket.
- **`dropper`** — the hosted-fleet mode; not for self-hosters.

Misconfiguration is never fatal: a bad cache config logs one warning, caching
turns off, and previews keep working. The full per-mode reference — every
variable, the s3 caveats, and the reasoning — lives in
[`.env.example`](https://github.com/amiantos/lurker/blob/main/.env.example),
which is worth reading in full before turning on `s3`.

### Secure cookies

Lurker's session cookies are **not** flagged `Secure` by default. This sounds wrong but is correct for the common self-hosted shapes:

- LAN / Tailscale / `*.local` hostnames over plain HTTP — browsers drop Secure cookies on non-localhost HTTP origins
- Cloudflare Tunnel, reverse proxies, etc. — the _browser_ sees HTTPS, but the container sees plain HTTP from the proxy, so even with TLS in front the cookie travels cleartext over Docker's internal network (which is fine — that traffic never leaves the host)

If you genuinely serve Lurker over end-to-end HTTPS (Express terminating TLS directly), set:

```yaml
environment:
  - COOKIE_SECURE=true
```

### Auth rate limiting behind a proxy

Lurker throttles repeated failed logins per client IP (a per-IP backoff on the login, token, and password-change endpoints, plus a coarse request cap on the auth surface). By default it uses the connection's socket address, which is correct when Lurker faces the internet directly.

If you run Lurker behind a reverse proxy or tunnel (Caddy, nginx, Cloudflare), the socket address is the _proxy_, so every visitor would share one bucket. Set this **only** when a proxy you control populates `X-Forwarded-For`, so Lurker keys on the real client:

```yaml
environment:
  - LURKER_TRUST_PROXY=true
```

Do **not** set it on a directly-exposed instance — `X-Forwarded-For` is then attacker-spoofable and an attacker can dodge the limit by rotating a fake value.

### Custom session secret

By default Lurker generates a random 64-byte secret on first boot and writes it to `data/session-secret.key` (mode `0600`). All session cookies are signed with it. If you'd rather supply your own (e.g. pulled from a secrets manager), set:

```yaml
environment:
  - SESSION_SECRET=replace-me-with-a-long-random-string
```

When set, the env var takes precedence and the file is ignored.

### Outbound contact info (User-Agent)

When Lurker talks to external services (image hosts, link previews, etc.) and replies to CTCP VERSION on IRC, it identifies itself with a User-Agent string. Set `USER_AGENT_CONTACT` to a `mailto:` or URL so the operators of those services can reach _you_ if your instance misbehaves:

```yaml
environment:
  - USER_AGENT_CONTACT=https://lurker.example.com
```

Unset, it falls back to the upstream project link.

### IRC bouncer (attach from other IRC clients)

Lurker can act as a bouncer (ZNC- and soju-compatible): enable the built-in IRC listener and any ordinary IRC client (WeeChat, irssi, Textual, HexChat, …) can attach to the same always-on connection your web UI uses — same nick, same channels, recent history replayed on attach, and anything you send from the client lands in your Lurker history and web tabs too. Detaching never disconnects you from IRC.

```yaml
environment:
  - LURKER_BOUNCER_ENABLED=true
  - LURKER_BOUNCER_PORT=6667 # remember to publish this port in docker-compose
```

Point your IRC client at the host/port with a **server password** of:

- `username:secret` — when you have one network configured
- `username/networkname:secret` — to pick one of several (the network's name as shown in the web UI, or its numeric id)

The secret can be your Lurker account password, but a **read-write API token** (web UI → **Settings → API tokens**) is the better choice — IRC clients store the server password in plaintext config files, and a token can be revoked without changing your password.

Modern IRCv3 clients (Halloy, gamja, Goguma, …) get more than the server-password floor above:

- **SASL** — log in with the same credential via SASL PLAIN instead of a server password.
- **Network discovery** (`soju.im/bouncer-networks`) — the client lists and binds your networks itself, so you don't hardcode `username/networkname`; connect as just `username` and pick from the list.
- **On-demand scrollback** (`draft/chathistory`) — page back through history on demand instead of relying only on the fixed replay-on-attach.

These are negotiated automatically; plain clients that don't support them keep working over the server-password path.

#### TLS

Plain-text IRC would send that credential across the wire in the clear, so **the bouncer speaks TLS by default** — you don't have to do anything to get an encrypted connection. Connect in your IRC client's **TLS/SSL** mode. There are three ways the cert is sourced:

- **Self-signed (default, zero setup).** With no cert configured, Lurker generates a self-signed cert on first boot and persists it next to the database (so it survives container rebuilds). It's the ZNC model: the wire is encrypted, and to also protect against man-in-the-middle you **pin the certificate's fingerprint** in your client. Lurker prints the SHA-256 fingerprint at startup — in the container logs and in the in-app **system buffer** — e.g. `TLS certificate fingerprint (SHA-256): AB:CD:…`. Most clients (WeeChat, irssi, Textual, …) let you pin that fingerprint; do it once and any impostor cert is rejected thereafter.

- **Your own Let's Encrypt cert (browser-trusted, no pinning).** If you want a cert clients trust without pinning, get one for a hostname (e.g. `irc.example.com`) with certbot and point Lurker at the PEM files — bind-mount them into the container and set:

  ```yaml
  environment:
    - LURKER_BOUNCER_TLS_CERT=/certs/fullchain.pem
    - LURKER_BOUNCER_TLS_KEY=/certs/privkey.pem
  ```

  Note the bouncer is raw IRC over TCP, so your **HTTP reverse proxy (Caddy/Cloudflare) can't front it** — the bouncer terminates its own TLS. Lurker re-reads the cert files periodically and hot-swaps a renewed cert, so certbot renewals need no restart.

- **Plain-text (opt-in, private networks only).** If — and only if — you keep the listener private (`LURKER_BOUNCER_BIND=127.0.0.1` behind an SSH tunnel, or a VPN/Tailscale interface), you can turn TLS off with `LURKER_BOUNCER_TLS=off`. On a non-loopback bind without TLS, Lurker logs a loud security warning. Don't do this on a public address.

Repeated failed logins from an address are throttled automatically.

Playback replays the last 50 lines per joined channel (plus your 20 most recently active DMs) on attach; tune with `LURKER_BOUNCER_PLAYBACK` (0 disables, max 1000). Clients that negotiate IRCv3 `server-time` get real timestamps on replayed lines.

Known limitations (shared-connection bouncer semantics): replies to one attached client's WHOIS/LIST are visible to all attached clients on that network; Lurker-side ignore rules don't filter the live relay; and on end-to-end encrypted channels an attached client sees the wire ciphertext for incoming messages.

---

## Troubleshooting

### Forgot the admin password

The cleanest path is to invite a second admin from your phone if you're still logged in there, then have them reset things from the admin panel.

If you're locked out everywhere, the fallback is to clear the password hash directly with sqlite and re-bootstrap. With the server stopped:

```bash
docker compose down
sqlite3 data/lurker.db "DELETE FROM users WHERE username = 'your-username';"
docker compose up -d
```

This destroys that user's account and history. If you were the only user, the next visit will return you to the first-run wizard so you can create a fresh admin. (A proper password-reset CLI is on the roadmap.)

### Port 8015 already in use

Edit the `ports:` line in your `docker-compose.yml` — the first number is the host port:

```yaml
ports:
  - '9999:8015'
```

Now Lurker is reachable on `http://localhost:9999`.

### Reverse-proxy / CORS errors

If you're seeing browser console errors about CORS, your browser is hitting a different origin than what Lurker expects. The bundled image serves both the API and the UI from the same port, so the default no-`CORS_ORIGIN` config is correct for almost everyone. Only set `CORS_ORIGIN` if you're running the Vue dev server (`npm run dev`) against a containerized API, or doing something similarly unusual.

A related failure mode is a **WebSocket that `403`s while the page itself loads fine** — the UI appears but never connects, and this typically shows up right after upgrading to 1.1.1. That's the same-origin check on the `/ws` upgrade, not a browser CORS error. It means your reverse proxy isn't forwarding the browser's host to Lurker. Fix it at the proxy (`proxy_set_header Host $http_host;` on nginx, or `X-Forwarded-Host`), or set `CORS_ORIGIN` to your public origin. See [Alternative: any reverse proxy](#alternative-any-reverse-proxy) for the full `location` block. When you do set `CORS_ORIGIN`, it must match the address you load Lurker at exactly on scheme, host, and port — a trailing slash is fine and a comma-separated list is allowed, but `http` vs `https` or a stray port will not match.

### Uploaded images are broken for other people (403)

Symptom: you're using the **local** uploader, and an uploaded image loads fine when you open the link in a new tab, but shows as broken when it's embedded — in someone else's client, or in Lurker's own image viewer on a different domain.

That asymmetry is the tell. Opening a link directly and embedding it on a page are different requests: the embedded one carries a `Referer` header naming the page it's embedded on. **Cloudflare's Hotlink Protection blocks image files whose `Referer` is a different domain**, returning a `403` at the edge before the request ever reaches Lurker.

Confirm it with two `curl`s against the same URL, where the _only_ difference is the `Referer` header:

```bash
# 1. No referer → 200, and Lurker serves the image
curl -sS -o /dev/null -D - \
  https://lurker.example.com/uploads/<key>.<ext> \
  | grep -iE '^HTTP/|^content-type:'
#   HTTP/2 200
#   content-type: image/webp     ← or image/jpeg, depending on the upload

# 2. Cross-domain referer → 403, and your image never gets served
curl -sS -o /dev/null -D - -H 'Referer: https://example.org/' \
  https://lurker.example.com/uploads/<key>.<ext> \
  | grep -iE '^HTTP/|^content-type:|^vary:'
#   HTTP/2 403
#   content-type: text/plain; charset=UTF-8
#   vary: referer
```

If adding a `Referer` is all it takes to flip a `200` into a `403`, that's Hotlink Protection. The `403` comes back as `text/plain` (Cloudflare's block page) rather than your image, and `vary: referer` is Cloudflare telling you the decision was made on the referer.

> Don't try to tell the two apart by looking for `server: cloudflare` — Cloudflare proxies the _successful_ response too, so that header is on both. The status flip is the signal.

Turn Hotlink Protection off (or scope it around `/uploads/`) — see [File uploads on your own disk](#file-uploads-on-your-own-disk).

### Container logs

```bash
docker compose logs -f lurker
```

Will stream Lurker's stdout, including connection events, push delivery results, and any tracebacks.

---

## Advanced: docker-compose.override.yml

Compose auto-merges a `docker-compose.override.yml` file (gitignored, never committed) on top of the main `docker-compose.yml`. This is the clean way to add your own settings without touching the upstream file — useful if you want to `git pull` updates without conflicts.

A starter template is checked in as `docker-compose.override.yml.example`. Copy it to `docker-compose.override.yml` and edit. The example shows the pattern the upstream maintainer uses (pulling secrets from a `.env` file, attaching to an external reverse-proxy network).

---

## Running without Docker

If you'd rather run Lurker directly on a host:

```bash
git clone https://github.com/amiantos/lurker.git
cd lurker
npm run install:all
npm run client:build
npm start
```

The server listens on port 8010 by default. Configure with the same envvars described above (set them in a `.env` file next to `package.json`, or export them in your shell). Use a process supervisor (`systemd`, `pm2`, etc.) to keep it running: it restarts the server after a crash, which nothing else on this page does. Backgrounding with `disown` and logging out also works — the server survives its terminal going away — but console output is gone for good at that point (the in-app system log keeps recording), and a crash stays down until you notice.
