# Switching to the IRC engine

Every Lurker upgrade restarts the container, and the container holds your IRC connections — so every upgrade has meant a reconnect: re-register, re-identify, rejoin, and a `Quit`/`Join` for everyone in your channels. The **engine** ends that. It is a second container that holds the IRC sockets and nothing else, and the ordinary upgrade never recreates it.

This page is the one-time switch, start to finish, for an instance you already run. [Self-Hosting Lurker](/SELF_HOSTING#irc-engine-upgrade-without-dropping-irc) is the reference for the same feature — every setting, and the details this page keeps short.

It is entirely optional. Nothing below is required to keep running Lurker exactly as you do now.

## What it costs

Honest list, so none of it is a surprise later:

- **One last reconnect** when you first enable it, and another if you ever turn it off.
- **A second container**, sharing your host's memory. It holds no data — no database, no uploads, no volumes.
- **identd moves.** If you answer ident (`LURKER_IDENTD_ENABLED` or `LURKER_OIDENTD_FILE`), that job belongs to the engine now, because the engine is the process holding the socket the network asks about. This is the one step people get wrong; it has its own section below.
- **Engine upgrades still drop IRC.** They are rare and called out in release notes.

---

## Step 0 — upgrade normally first

Do this before anything else, and let it sit for a bit:

```bash
docker compose pull
docker compose up -d
```

**Nothing about the engine turns on by upgrading.** The presence of `LURKER_ENGINE_URL` is the entire switch, and you have not set it. Concretely, on this release without the engine:

- no schema change, and no new tables — nothing is written anywhere new
- identd behaves exactly as before
- the app dials IRC itself, exactly as before

So a normal upgrade is a normal upgrade. Confirm your instance is healthy on the new version, and only then continue. If you switch at the same moment you upgrade and something misbehaves, you will not know which change caused it.

---

## Step 1 — get the compose file

`docker-compose.engine.yml` ships in the repository, not inside the image, so pulling a new image is not enough:

```bash
git pull
ls docker-compose.engine.yml
```

If you did not clone the repo — the DigitalOcean one-shot deploy, for instance — download that one file next to your `docker-compose.yml`.

---

## Step 2 — set the shared secret

The app authenticates to the engine with it, and it is the only thing that does:

```bash
echo "LURKER_ENGINE_SECRET=$(openssl rand -hex 32)" >> .env
```

---

## Step 3 — decide how you invoke Compose ⚠ {#compose-files}

This trips people up, and it is worth thirty seconds now rather than a confusing hour later.

**Compose stops auto-loading `docker-compose.override.yml` the moment you pass `-f`.** The override is merged only during Compose's _default_ file resolution; once you name files explicitly, you get exactly the files you name.

So if you have a `docker-compose.override.yml` — where most people keep their reverse-proxy network, their `113:113` mapping, their secrets — this **silently drops it**:

```bash
docker compose -f docker-compose.yml -f docker-compose.engine.yml up -d   # ⚠ override NOT loaded
```

List it too, and put the whole thing in `.env` so your everyday commands go back to being short:

```bash
# .env — include docker-compose.override.yml ONLY if you have one
COMPOSE_FILE=docker-compose.yml:docker-compose.engine.yml:docker-compose.override.yml
```

From here on, plain `docker compose pull` / `docker compose up -d` do the right thing. Check it before you go further:

```bash
docker compose config --services      # expect: lurker, lurker-engine
docker compose config | grep -A3 'ports:'   # your own mappings should still be here
```

---

## Step 4 — move identd, if you answer ident

Skip this entirely if you do not run identd — most people do not, and networks that do not ask will not notice.

If you do, the settings and the port move from `lurker` to `lurker-engine`. Where they live decides the work:

- **In `.env`:** nothing to edit. The overlay forwards `LURKER_IDENTD_ENABLED`, `LURKER_IDENTD_PORT`, `LURKER_IDENTD_BIND` and `LURKER_OIDENTD_FILE` to the engine for you.
- **In an `environment:` block on `lurker` in your override:** move that block to `lurker-engine`. The overlay cannot see values set there.

The host `:113` mapping is yours to move as well, along with the oidentd bind mount if you use file mode. In `docker-compose.override.yml`:

```yaml
services:
  lurker-engine:
    ports:
      - '113:113' # built-in identd
    volumes:
      - ./oidentd:/oidentd # oidentd file mode
```

…and delete the same from `lurker`. `LURKER_OUTGOING_ADDR` is the exception and **stays on `lurker`**: the app reads it and tells the engine which address to bind, though the address has to exist on the engine's host.

Full detail in [Self-Hosting](/SELF_HOSTING#irc-engine-upgrade-without-dropping-irc).

---

## Step 5 — bring it up

```bash
docker compose pull
docker compose up -d
```

**This one drops IRC.** It recreates `lurker` with `LURKER_ENGINE_URL` set — the last reconnect you should need. Your client reconnects on its own, as after any restart.

---

## Step 6 — prove it works

Ask the engine what it is holding. It publishes no port, so ask from inside the network:

```bash
docker compose exec lurker \
  node -e "require('http').get('http://lurker-engine:8016/healthz',r=>r.pipe(process.stdout))"
```

`{"ok":true,"held":2}` — `held` is the number of IRC connections it is keeping for you. If it is `0` while you are connected, the app is dialling IRC itself and something above is wrong; see [Troubleshooting](#if-something-is-wrong).

Now the test that actually matters. Join a channel, say something, then recreate **only the app**:

```bash
docker compose up -d --force-recreate lurker
```

Watch your IRC client. Your nick should be unchanged, your channels still joined, and nobody in them should see you `Quit` and `Join`. Anything said while the app was restarting arrives when it comes back. That is the whole feature, and you can run this any time without waiting for a release.

---

## Living with it

Upgrades are what they always were:

```bash
docker compose pull
docker compose up -d
```

Only `lurker` is replaced. `pull` fetches nothing new for the engine, and `up -d` leaves it running.

**What still drops IRC:**

- An **engine** upgrade. Its tag is `engine-1`, which moves only when a release changes the engine — rare, and called out in that release's notes.
- A release needing **`engine-2`**. Called out too, and for that one **stop the engine first**, then upgrade both:
  ```bash
  docker compose stop lurker-engine
  docker compose pull && docker compose up -d
  ```
  An old engine that refuses the new app would otherwise hold every session open while the app dials its own and collides with its ghosts. (Sessions no app claims for an hour are ended — `LURKER_ENGINE_ORPHAN_MS` — but that is a backstop, not a procedure.)
- Rebooting the host, obviously.

**While the app is down**, the engine keeps what arrives: 4 MiB per connection, 256 MiB in total, tunable with `LURKER_ENGINE_BUFFER_BYTES` and `LURKER_ENGINE_BUFFER_TOTAL_BYTES`. Past the cap the oldest lines go and the app notes where the hole is. Deploys take seconds; the buffer covers hours of ordinary traffic.

---

## Turning it off again

**Stop the engine first**, or the network briefly sees two of you. If you added the `COMPOSE_FILE` line, take the overlay out of it before bringing the stack back up — otherwise the plain command loads it again and restarts the engine you just stopped:

```bash
docker compose stop lurker-engine
# .env: COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml
docker compose up -d --remove-orphans
```

That is one more reconnect, and you are back exactly where you started. Move identd back if you moved it.

---

## If something is wrong {#if-something-is-wrong}

Two failures look similar and mean opposite things. `docker compose logs lurker` tells you which:

- **Refused** — wrong `LURKER_ENGINE_SECRET`, or an app that needs a newer engine. The app says so at startup and **falls back to dialling IRC directly** for that run. IRC works; ident is not answered until you fix it, because `:113` is the engine's now.
- **Unreachable** — the engine is down, or `LURKER_ENGINE_URL` has a typo. This is **not** a fallback. The app stays in engine mode and its connections wait, retrying and logging that they are waiting, because the sockets may well still be alive in there.

Other things worth checking:

- **`held` is 0.** The app never reached the engine. Confirm both containers are up (`docker compose ps`) and that `LURKER_ENGINE_SECRET` is identical for both — the overlay reads it from `.env` for each, so a value set in an `environment:` block on only one of them is the usual cause.
- **Your reverse proxy or `:113` stopped working** after switching. Almost certainly the `-f` trap in [Step 3](#compose-files): check `docker compose config` and confirm your override is in `COMPOSE_FILE`.
- **`lurker-engine` restarts in a loop.** Read its log (`docker compose logs lurker-engine`). It refuses to start without `LURKER_ENGINE_SECRET`, and with buffer values below 65536 bytes.

---

## Running without Docker

The same two processes, on one host. Run the engine with `node_modules/.bin/tsx server/engine.ts`, sharing `LURKER_ENGINE_SECRET` with the app, and point the app at it:

```
LURKER_ENGINE_URL=tcp://127.0.0.1:8016
```

The engine binds `127.0.0.1:8016` by default, so it is not reachable from another machine unless you say so with `LURKER_ENGINE_LISTEN`. ⚠ Use `127.0.0.1` in the URL rather than `localhost`, which can resolve to `::1` first and be refused by a loopback-v4 bind. If you put the engine on a _different_ host, you must widen the bind — and then that secret is doing real work across a real network, so give it a private network or a tunnel, never the open internet.
