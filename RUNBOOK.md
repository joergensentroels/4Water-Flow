# Runbook — 4water scheduling

This is the succession plan, not documentation ceremony. If the person who built it is unavailable, everything
needed to keep the app running is on this page.

**Where it runs:** Docker Compose on the host 4water's Lyon department already operates (the NextCloud box).
They agreed to host it. Hosting follows the operators — they run the machine, so they own the deployment.

**⚠ Not yet verified:** the image has never been built. Docker was not installed on the machine this was
written on, so `docker compose build` is untested. Everything else below has been exercised: the app boots
under the image's exact environment, the healthcheck command exits 0, a restored backup boots and serves, and
the whole suite passes on a clean `git clone`. Expect the first build to need small fixes; nothing else here
depends on it.

**The size of the test suite is not stated here on purpose.** `PLAN.md` holds that number, in one place, and a
test asserts no other document states one. Three did, and at one point they claimed a hundred-and-something,
three-hundred-and-something, and the same three-hundred-and-something again, while the suite was a fourth number
— all three wrong simultaneously, which is what a count kept in several places does. Say "the whole suite" and
look the number up if you need it.

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

Two more are worth setting even though nothing forces them:

- **`FOURWATER_BASE_URL`** — e.g. `https://plan-cph.4water.org`. Without it, the bootstrap invite link and the
  volunteer calendar link are printed as paths, and a volunteer pasting `/calendar/….ics` into their calendar
  app gets nothing. The app will not guess the origin from the `Host` header on purpose: a request with a
  forged Host would render a link pointing at someone else's server, and the volunteer would paste their own
  token into it.
- **`calendar.timezone` in `config/pattern.json`** — already set to `Europe/Copenhagen`. This is what puts a
  19:00 shift at 19:00 in a subscriber's calendar. Change the department and forget this, and every event is
  silently off by the UTC offset for the whole season.

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
docker compose run --rm --entrypoint sh app -c "cp /data/backups/4water-<STAMP>.sqlite /data/4water.db"
docker compose start app
```

There is deliberately **no `-v 4water-data:/data`** on that line. The `app` service already mounts the volume, so
the flag was redundant — and worse than redundant: `-v` takes a raw Docker volume name, not a Compose one, and
Compose prefixes volumes with the project name unless told otherwise. It would have created a brand-new empty
volume called `4water-data`, mounted it over `/data`, copied nothing, and started the app on the database you were
trying to replace. `compose.yml` now pins `name: 4water-data` so the two names agree, but the flag is still not
needed here.

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
| Nobody is being notified | `MATTERMOST_WEBHOOK` set? If not, messages queue in the `notifications` table rather than being lost. Check for rows with `status='failed'` — the `error` column says why. `the webhook did not answer within 8s` means Mattermost accepted the connection and went quiet; the message is kept as failed and the next nudge retries it, rather than the run stalling on it. |
| The app is up but the plan looks empty | Check the season in **Administration** — a season entirely in the past has no upcoming sessions. |
| Container keeps restarting | `docker compose logs --tail=100 app`. A missing `FOURWATER_SECRET` is the usual cause and says so. |
| `4water Flow needs Node 22.13.0 or newer` | Exactly what it says. See **The one dependency risk** below. |
| `No such built-in module: node:sqlite` | Node older than 22.13. Upgrade Node; nothing else will fix it. |
| `/status` says sign-in is "guessing NextCloud's usual addresses" | Endpoint discovery is failing. See `docs/OIDC.md` §2 — sign-in still works, but you are one NextCloud upgrade away from an outage. |
| `127.0.0.1:8080 is already in use` | Another copy is still running. Stop it, or start this one on another port. Until recently the app printed `4water listening on …` *before* the bind failed, so a collision read as a clean start followed by an unrelated crash — if you are looking at older logs, do not trust that line. |
| Volunteers say they get too many / too few shift reminders | One reminder per person per shift, ever, sent when the shift is within `notify.remindDaysBefore` days (default 2, max 14; `0` means same-day only). Set it in `config/pattern.json`. Only **confirmed** shifts are reminded about — an auto-roster proposal never is, on purpose. A volunteer who hands a shift back and reclaims the same one will not get a second reminder. |
| The season export opens as one long column | Your spreadsheet is splitting on a different list separator than the file uses. Set `export.csvDelimiter` in `config/pattern.json` — `";"` for a spreadsheet on a Danish or German locale, `","` for Google Sheets, LibreOffice or a script. Nothing else needs changing; it is one line and takes effect on restart. |
| Danish letters in the export look like `SÃ¸ren` | That would mean the byte-order mark is missing from the file. The export writes one deliberately, because a downloaded `.csv` is read from disk where the response's `charset=utf-8` cannot help, and without the mark a spreadsheet on Windows decodes it in the system codepage. If you see this, the file has been re-saved by something in between — check whatever opened it first. |
| The plan looks lopsided after auto-roster | Open **How the season is spread** on the planning screen. It lists everyone busiest-first, flags anyone whose shifts nearly all fall on one weekday, and names the volunteers who have been given nothing. See **Is the auto-roster fair?** below. |

## What version is this, and what would make it 1.0.0

**`1.0.0-rc.1`.** `/status` shows it as its last line, which is the answer to the first question any support
conversation asks. It is also the only thing that reads `package.json` at runtime.

The suffix is deliberate and is the honest part. The app is feature-complete, its whole suite passes on a clean
`git clone`, and every mechanically checkable claim in these documents is verified by a test. None of that
is the same as having worked. **Four things have never happened**, and each is a release-blocker rather than a
nice-to-have:

1. **The container image has never been built.** Verified as far as is possible without a runtime — the copied
   file set boots the real entry point, the base tag is checked against the Node floor — but not built.
2. **Sign-in has never spoken to 4water's NextCloud.** It runs end to end against a conforming provider. Work
   through `docs/OIDC.md` on the real instance; invite links need none of this and work today.
3. **No volunteer has used it.** Every usability judgement is reasoned from the reported pain, not observed.
4. **Three configuration values are invented** — the clock times, the hand-back cutoff, and the shift length.
   They are marked as placeholders in `config/pattern.json` and only 4water can answer them.

Call it 1.0.0 when a season has actually been planned in it. Until then the suffix is telling whoever inherits
this the truth, and the truth is useful: it says which parts to be suspicious of first.

## Is the auto-roster fair?

Measured, on a full 26-week season seeded from nothing: 178 slots, twelve volunteers with deliberately uneven
capabilities and availability. Two answers, and they are different answers.

**On how much work each person gets, it is as even as availability allows.** The four volunteers who offered
most availability came out on 21, 22, 22 and 23 shifts. Everyone below that was limited by what they had
offered, not by the algorithm — the volunteer who marked three evenings free got three shifts. There is no
setting to tune here and no known way to do better without asking people for more availability.

**On *which* shifts, it concentrates.** Three of those four offered two weekdays roughly equally and were
given 78%, 82% and 91% of their shifts on a single one. That is not a bug in the balancing; it is what a
stable tie-break does against a weekly rhythm — the rotation settles into a period that divides the week, so
the same people keep landing on the same evening.

**Whether that is a problem is 4water's call, and the app deliberately does not decide it.** "I always get
stuck with Sundays" is a real reason volunteers stop showing up. Having the same two teachers every Sunday is
also real continuity for a class. So the planning screen *reports* it — **How the season is spread**, flagging
anyone at 75% or more on one weekday — and leaves the judgement to a person. It only flags volunteers who
offered more than one weekday: someone who only ever marked Sundays was not put there by a machine.

If you decide the concentration is wrong, the fix is not a setting. Unassign the affected shifts and reassign
them by hand, or lock in a partial plan and re-run: auto-roster never touches locked work, so you can pin the
rotation you want and let it fill the rest around you.

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
- **CI is set up to run the suite on both the pinned LTS and current Node, and has never actually run**, because
  this repository has no remote yet. The workflow is correct and the intent stands — a breaking change in
  `node:sqlite` should show up as a red build rather than as a broken deployment mid-season — but it is a plan,
  not a thing that has happened, and the difference mattered: three tests read a file `.gitignore` excludes, so
  the first CI run would have been red for a reason having nothing to do with Node. That is fixed, and the suite
  is verified against an actual `git clone` rather than against this working copy. **Push the repo and confirm
  the first run is green before relying on this line.** What is and is not already checked, so a red first build
  is quick to triage: the first two steps (`node --version`, `node --test`) have been run against a real clone
  and pass. The last two are Linux shell wrappers — `/tmp` paths and a backgrounded server — around properties
  the cross-platform suite already asserts anyway (`test/image.test.mjs` boots the entry point and checks it
  seeded slots; `test/backup.test.mjs` covers `verifyBackup`). Those wrappers could not be validated from the
  Windows machine this was written on, because `/tmp/ci.db` resolves to `C:\tmp\ci.db` there. So if the first
  build is red on one of those two steps, suspect the shell rather than the app.
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
