# Runbook — 4water scheduling

This is the succession plan, not documentation ceremony. If the person who built it is unavailable, everything
needed to keep the app running is on this page.

**Where it runs:** Docker Compose on the host 4water's Lyon department already operates (the NextCloud box).
They agreed to host it. Hosting follows the operators — they run the machine, so they own the deployment.

**⚠ Not yet verified:** the image has never been built. Docker was not installed on the machine this was
written on, so `docker compose build` is untested. Everything else below has been exercised: the app boots
under the image's exact environment, the healthcheck command exits 0, backups restore into a working
database, and 129+ automated checks pass. Expect the first build to need small fixes; nothing else here
depends on it.

---

## Deploy

```bash
cp .env.example .env
```

Fill in `.env`. Only one value is mandatory:

```bash
openssl rand -hex 32
```

Put that in `FOURWATER_SECRET`. The app **refuses to start** without it rather than falling back to a
guessable default — if it exits complaining about `FOURWATER_SECRET`, that is working as intended.

```bash
docker compose up -d --build
```

### Create the first administrator — the deployment is a locked door without it

A fresh database has no people. The developer sign-in does not function under `NODE_ENV=production`, and
NextCloud sign-in deliberately refuses anyone not already on the roster, so **there is no way in until you do
this**:

```bash
docker compose exec app node tools/bootstrap.mjs you@4water.org "Your Name"
```

It prints a single-use link. Open it once to sign in; you get administrator and planner. From there, invite
everyone else from the Administration screen. Running it twice is harmless.

If you skip this, the app starts and answers `/healthz` perfectly while letting nobody in — so it also prints
a warning at boot saying exactly this. Check `docker compose logs app` if sign-in seems impossible.

Then point the existing reverse proxy (the one already fronting NextCloud) at `127.0.0.1:8080` for
`plan-cph.4water.org`. The app binds to loopback on purpose: TLS is the proxy's job.

Check it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/healthz
```

`200` means it is up. Anything else: `docker compose logs --tail=50 app`.

## Update to a new version

```bash
git pull && docker compose up -d --build
```

The database is on a named volume, so it survives. Migrations run automatically at boot and are idempotent —
starting an older image against a newer database is the only risky direction, so do not roll back the image
without restoring a backup from before the upgrade.

## Restore from a backup

Backups are nightly `.sqlite` files in the `4water-data` volume under `/data/backups`, and uploaded to
4water's own NextCloud if that is configured. Fourteen are kept.

```bash
docker compose stop app
docker compose run --rm -v 4water-data:/data --entrypoint sh app -c "cp /data/backups/4water-<STAMP>.sqlite /data/4water.db"
docker compose start app
```

Then confirm before telling anyone it worked:

```bash
docker compose run --rm --entrypoint node app -e "import('./tools/backup.mjs').then(m=>console.log(m.verifyBackup('/data/4water.db')))"
```

It prints `ok: true` and row counts. **A backup nobody has restored is a hope, not a backup** — worth doing
once deliberately, on a spare copy, before you ever need it.

## Run a backup by hand

```bash
docker compose run --rm backup
```

It prints what it wrote, what retention removed, and whether the upload succeeded. It refuses to write
backups inside a git work tree or a cloud-sync folder, because the file contains every volunteer's name and
contact details.

Schedule it nightly from the host — cron or a systemd timer, whichever the host already uses:

```bash
30 3 * * * cd /srv/4water-cph && docker compose run --rm backup >> /var/log/4water-backup.log 2>&1
```

## Add a planner or an admin

Sign in as an admin → **Administration** → find the person → press `+ Planner` or `+ Administrator`.

The last administrator **cannot** remove their own admin role. If you genuinely need to hand over, grant
admin to the other person first, then remove it from yourself.

## Add a volunteer who has no NextCloud account

**Administration** → **Invitations** → enter their email → **Send an invitation**. The link appears **once**
and is never recoverable — only a hash of it is stored, so a stolen database yields no working invite links.
Copy it and send it to them. It is single-use and expires after 14 days.

## Change the season, the activities, or the hand-back deadline

**Administration** → **Season** / **Activities**. Changes are validated before anything is written, written
atomically, and picked up immediately — no restart. An invalid change is refused with a message saying what
was wrong, and the file on disk is left untouched.

Removing an activity stops new sessions being created for it and **leaves existing ones alone**, because
deleting sessions would destroy assignments volunteers have already agreed to.

## When something is wrong

| Symptom | Look here |
|---|---|
| Nobody can sign in | Is NextCloud up? OIDC depends on it. Invite links do not — issue one to get back in. |
| Volunteers see an empty board | They have not entered availability. Silence is treated as unavailable, on purpose. |
| Nobody is being notified | `MATTERMOST_WEBHOOK` set? If not, messages queue in the `notifications` table rather than being lost. Check for rows with `status='failed'`. |
| The app is up but the plan looks empty | Check the season in **Administration** — a season entirely in the past has no upcoming sessions. |
| Container keeps restarting | `docker compose logs --tail=100 app`. A missing `FOURWATER_SECRET` is the usual cause and says so. |
| `4water Flow needs Node 22.13.0 or newer` | Exactly what it says. See **The one dependency risk** below. |
| `No such built-in module: node:sqlite` | Node older than 22.13. Upgrade Node; nothing else will fix it. |
| `/status` says sign-in is "guessing NextCloud's usual addresses" | Endpoint discovery is failing. See `docs/OIDC.md` §2 — sign-in still works, but you are one NextCloud upgrade away from an outage. |

## The one dependency risk

This app has **no dependencies**, which removes almost every supply-chain and upgrade problem — and
concentrates what is left into a single point: it stores everything in `node:sqlite`, Node's built-in SQLite,
which is **Stability 1.2, "Release candidate"**. Not stable. The API is permitted to change.

What that means in practice:

- **Node ≥ 22.13 is required**, not 22.5 as earlier versions of these documents said. `node:sqlite` was added
  in 22.5.0 but sat behind `--experimental-sqlite` until 22.13.0. The app checks at startup and refuses with a
  message naming the version it found, rather than failing at an import nobody can interpret.
- **The Dockerfile pins an exact Node minor** (currently 22.14) so a host rebuild cannot move the runtime under
  the app. Do not relax that pin to `node:22`.
- **CI runs the suite on both the pinned LTS and current Node.** A breaking change in `node:sqlite` therefore
  shows up as a red build rather than as a broken deployment in the middle of a season.
- **If it ever does break:** stay on the pinned Node version — nothing forces an upgrade — and raise it as an
  issue. The database file is ordinary SQLite, readable by any `sqlite3` binary, so the data is never trapped
  by this choice. That property is what makes the risk acceptable rather than reckless.

## Things that will bite if you do not know them

- **Do not put the data volume on network storage (NFS/CIFS).** SQLite's locking assumes a local filesystem;
  network storage can corrupt the database. This is the one deployment choice that can lose data.
- **`MATTERMOST_WEBHOOK` is a credential.** Anyone holding it can post as the integration. The app never logs
  it — do not paste it into a ticket.
- **Use a NextCloud app password for backups, never the account password.**
- **The `dev` sign-in cannot run in production.** Two independent switches must both be set, and
  `NODE_ENV=production` refuses regardless. Verified by an automated test that boots the app with both flags
  set the wrong way and checks no session is issued.

## Who to call

- Copenhagen scheduling: the 4water Copenhagen board.
- The host and container: 4water Lyon's technical volunteers.
- The code: this repository. `npm test` runs everything and needs no network, no database and no setup.

Any decision that looks arbitrary is probably explained in `../4water-scheduling-spec.md`, and the build order
in `PLAN.md`.
