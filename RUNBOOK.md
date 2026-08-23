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
  volunteer calendar link are printed as paths, a volunteer pasting `/calendar/….ics` into their calendar app
  gets nothing, and **every notification goes out with no link in it** — so the message that says a shift is
  open, or that yours is in two days, names a screen the reader cannot click to. The app will not guess the
  origin from the `Host` header on purpose: a request with a forged Host would render a link pointing at
  someone else's server, and the volunteer would paste their own token into it. A value that is not a valid
  http/https URL is refused at startup rather than pasted into every message the app sends.
- **`calendar.timezone` in `config/pattern.json`** — already set to `Europe/Copenhagen`. This is what puts a
  19:00 shift at 19:00 in a subscriber's calendar. Change the department and forget this, and every event is
  silently off by the UTC offset for the whole season.

```bash
docker compose up -d --build
```

### Everything else the environment can set

Complete, and kept complete by a test: `test/docs.test.mjs` fails if the app reads a variable no document names.
It was added because seven of these were undocumented, including the three that switch on off-site backup — so
an operator could not have discovered off-site backup existed without reading the source.

| Variable | Default | What it decides |
|---|---|---|
| `FOURWATER_SECRET` | *none — refuses to start* | Signs session cookies. 32+ random hex characters. |
| `FOURWATER_BASE_URL` | unset → links render as paths | See above. |
| `FOURWATER_DB` | `4water.db` beside the app | Where the SQLite database is. In the container, set it to the mounted volume — `/data/4water.db`. Resolved in one place (`src/config.mjs`) so the app and `tools/backup.mjs` cannot disagree about which file is the database; they used to. |
| `FOURWATER_PATTERN` | `config/pattern.json` | Which configuration file this instance reads. This is what lets one image run several departments. |
| `FOURWATER_AUTH` | unset | `dev` enables the passwordless dev sign-in. Ignored when `NODE_ENV=production`, and the dev provider refuses to construct without it. Never set this on a real deployment. |
| `FOURWATER_BACKUP_DIR` | `backups/` beside the app | Where `tools/backup.mjs` writes. |
| `FOURWATER_BACKUP_KEEP` | `14` | How many backups survive pruning. Minimum 1 — a smaller or unparseable value is clamped, not obeyed, because a typo here silently deletes history. |
| `MATTERMOST_WEBHOOK` | unset → messages queue in the outbox | Where notifications are posted. **A credential** — see the warnings at the end of this file. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | unset | NextCloud sign-in. With any one blank the sign-in page does not offer it. `docs/OIDC.md` is the checklist. |
| `OIDC_SCOPE` | `openid profile email` | Override only if your provider needs different scopes. Getting it wrong shows up as a login that succeeds and returns no email, which the app then refuses. |
| `NEXTCLOUD_WEBDAV_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_APP_PASSWORD` | unset → **local backups only** | Off-site copy of each backup, over WebDAV. All three must be set or the upload is skipped and `tools/backup.mjs` prints `upload: skipped (local only)`. Use an **app password**, never the account password. An upload that fails exits non-zero, so a cron job reports it. |

### Create the first administrator — the deployment is a locked door without it

A fresh database has no people. The developer sign-in does not function under `NODE_ENV=production`, and
NextCloud sign-in deliberately refuses anyone not already on the roster, so **there is no way in until you do
this**:

```bash
docker compose exec app node tools/bootstrap.mjs you@4water.org "Your Name"
```

It prints a single-use link. Open it and press **Accept invitation**; you get administrator and planner. From
there, invite everyone else from the Administration screen. Running it twice is harmless.

Opening the link does not spend it — only the button does. That is deliberate, and it matters for the invitations
you send by email: mail security gateways fetch links to scan them before the recipient sees them, and while this
route redeemed on the fetch, the scanner got the account and the volunteer got *"We could not find you on the
list of volunteers"*. Re-inviting did not help, because the next link went down the same pipe. If a volunteer
reports that their invitation link does not work, this is no longer the cause.

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

**⚠ Marking somebody inactive does NOT take their access away.** This is the one thing on this page most likely
to be assumed wrong, so it is measured rather than described: `status='inactive'` is honoured by the eligibility
rules, the auto-roster, the claim guard and both notification jobs — it stops them being offered or assigned
anything, which is what it is for — **and it releases the shifts they had not yet done.** The page tells you how
many. It does not remove a role, and it does not stop them signing in. **An administrator who has stood down still
has full administrative access until you remove the role explicitly.** When somebody leaves, do both: remove the
role, then set them inactive.

Releasing the future shifts is not a convenience. Every one of those consumers skips an inactive person, so a shift
left on one was covered by nobody while the planner grid printed their name beside it — measured at 51 shifts held
by one deactivated volunteer, none of them opened, none of them reminded, and none of them offered on the exchange.
A gap that reads as filled is worse than a gap, because nobody chases it. Past shifts stay: they did run those.

Two related things follow from that, and both used to be wrong in the app rather than just undocumented. An
inactive admin is not counted as a spare when the app decides whether removing an admin would lock the
organisation out — correct, because an org that has stood somebody down is not relying on them. But that count
and the "is this person an admin" test disagreed about anybody inactive, so the app refused to remove a
stood-down admin's stale role *and* refused their own right-to-erasure request, both reporting "the last
administrator" when an active administrator was sitting right there. Fixed; the guard still refuses to erase or
demote the genuinely last active administrator.

## Add a volunteer who has no NextCloud account

**Administration** → **Invitations** → enter their email → **Send an invitation**. The link appears **once**
and is never recoverable — only a hash of it is stored, so a stolen database yields no working invite links.
Copy it and send it to them. It is single-use and expires after 14 days.

## Moving the whole roster over from the spreadsheet — budget an afternoon, and check it afterwards

There is no importer, deliberately (`README.md` says why). What that means in practice, so nobody plans it as a
five-minute job:

1. **~40 invitations**, one address at a time on **Administration → Invitations**. Each needs the volunteer to
   open the link and press **Accept invitation** before they exist as a person you can give capabilities to.
2. **The capability matrix — up to 40 people × 6 activities = 240 toggles.** One button per person per activity,
   no JavaScript anywhere in this app, so each one is a form submission and a page reload.
3. **Then read it back.** This is the step to not skip. Nothing validates the matrix, and a wrong cell is silent:
   a volunteer you did not mark as a Salsa leader is simply never offered Salsa, and the shift exchange tells them
   *"Nothing is open in the activities you run"* — true, and it hides your mistake rather than reporting it. The
   Administration roster prints each person's capabilities as text next to their name, so read that list against
   the sheet once, before the season opens.

Do steps 1 and 2 well before the season boundary. Step 3 is the only defence against a quiet gap in the roster,
and it is much cheaper than a planner discovering in week three that a slot has never had a candidate.

## Change the season, the activities, or the hand-back deadline

**Administration** → **Season** / **Activities**. Changes are validated before anything is written, written
atomically, and picked up immediately — no restart. An invalid change is refused with a message saying what
was wrong, and the file on disk is left untouched.

Removing an activity stops new sessions being created for it and **leaves existing ones alone**, because
deleting sessions would destroy assignments volunteers have already agreed to.

**`season.key` is the name the app uses to FIND the season in the database**, which makes it the one field on that
screen worth being careful with. Changing it does not rename a season — it points the app at a different one. If the
new name matches no season, or matches one that was never seeded, every screen empty-states and **the status page
reports it as a fault naming both keys**. That is the thing to look at if the plan goes blank after an edit here.

`season.from` and `season.to` are the season's first and last dates. Widening them and saving generates the missing
sessions; narrowing them does **not** delete the ones already created, for the same reason removing an activity does
not — deleting sessions would destroy assignments volunteers have agreed to.

## An activity with no weekly slot is never scheduled

Sessions come only from the weekly rhythm. An activity that exists in `config/pattern.json` and that no weekly entry
names has no dates, no slots and nobody on it — and a volunteer's capability for it can never be used. A test
requires each such activity to be declared with a reason, so one missing by accident is not indistinguishable from
one missing on purpose.

Three are in that position deliberately: the Steel House social and the two workshops. They happen on particular
dates rather than a fixed weekday. **A single date for one of them is not expressible today** — adding a weekly
entry makes it recur every week of the season, and the only way to thin that out is to close the other dates one at
a time. If 4water runs one-off sessions regularly, say so; it wants to be a feature rather than a workaround.

## Closing a single date — the venue is shut, the term breaks, nobody can teach

Administration → **Close a date**. Pick any date inside the season and the sessions on it are removed; the date is
written into `holidays.extra`, so it stays closed when the plan is next regenerated. Reopening it is the same
screen: the date appears in the list above with a **Classes run anyway** button.

A date where somebody has already taken a shift is **refused**, naming how many. Free those under Planning first —
removing the date would cancel on a volunteer who had agreed to be there. A date outside the season is refused too.

This is **no longer** how a fortnightly slot is expressed. Under **Administration** → the weekly rhythm, a slot's
**How often** field says every week, every 2nd, 3rd or 4th — the equivalent of the spreadsheet's `EveryNth` rule.
Every slot in the list shows its cadence, so "every week" is stated rather than assumed. Closing alternate dates by
hand was the old workaround, one action per skipped date across a six-month season; use the field instead.

Cadence counts in whole weeks from the season's start date, so editing the rhythm mid-season does not shift a
fortnightly slot to the opposite week. A public holiday does not shift it either: the suppressed date uses up its
turn, exactly as a cancelled class does, and the slot resumes on its normal week.

## Public holidays — no sessions on them unless you say otherwise

**Administration** → **Public holidays** lists every public holiday inside the season and what the app has done
about each. Nothing is created on those dates. If classes run anyway, say so there and the sessions are generated
for that one date; the other button removes them again, and **refuses if somebody is already on one** rather than
cancelling on a volunteer who agreed to teach. Both directions are in the change log.

Three keys in `config/pattern.json`, under `holidays`:

| key | what it does |
|---|---|
| `holidays.country` | `DK` or `FR`, an ISO 3166-1 alpha-2 code. An unrecognised code **suppresses nothing** rather than guessing a calendar, and the Administration screen says so — a wrong holiday table silently deletes real classes. |
| `holidays.extra` | Dates 4water is closed but the country is not. 24 and 31 December are there as a suggestion and the board can remove them; Grundlovsdag is deliberately absent, because an evening class can run on it. **Editable from the Administration screen** — see below; you do not need to touch this file. |
| `holidays.classesAnyway` | The planner's opt-back-in list. Written by the button on the Administration screen — no need to edit it by hand. |

Adding `holidays.country` to a deployment whose season is **already seeded** does not remove the sessions that
already exist, because seeding only ever adds. Those dates show up on the Administration screen saying how many
slots are still on them, with the button that clears them.

## When something is wrong

| Symptom | Look here |
|---|---|
| Nobody can sign in | Is NextCloud up? OIDC depends on it. Invite links do not — issue one to get back in. |
| Volunteers see an empty board | They have not entered availability. Silence is treated as unavailable, on purpose. |
| Nobody is being notified | `MATTERMOST_WEBHOOK` set? If not, messages queue in the `notifications` table rather than being lost. Check for rows with `status='failed'` — the `error` column says why. `the webhook did not answer within 8s` means Mattermost accepted the connection and went quiet; the message is kept as failed and the next nudge retries it, rather than the run stalling on it. |
| The app is up but the plan looks empty | Check the season in **Administration** — a season entirely in the past has no upcoming sessions. |
| Container keeps restarting | `docker compose logs --tail=100 app`. A missing `FOURWATER_SECRET` is the usual cause and says so. |
| `could not open its database at …` | The directory that path points into does not exist. In the container that means the `4water-data` volume is not mounted at `/data` — check `volumes:` in `compose.yml` and `docker volume ls`. SQLite creates the file but never the directory holding it, so this is the likeliest misconfiguration of a fresh deployment. The message names the path and the variable; it used to be a bare "unable to open database file" with a stack trace and neither. |
| `4water Flow needs Node 22.13.0 or newer` | Exactly what it says. See **The one dependency risk** below. |
| `No such built-in module: node:sqlite` | Node older than 22.13. Upgrade Node; nothing else will fix it. |
| `/status` says sign-in is "guessing NextCloud's usual addresses" | Endpoint discovery is failing. See `docs/OIDC.md` §2 — sign-in still works, but you are one NextCloud upgrade away from an outage. |
| `127.0.0.1:8080 is already in use` | Another copy is still running. Stop it, or start this one on another port. Until recently the app printed `4water listening on …` *before* the bind failed, so a collision read as a clean start followed by an unrelated crash — if you are looking at older logs, do not trust that line. |
| Volunteers say they get too many / too few shift reminders | One reminder per person per shift, ever, sent when the shift is within `notify.remindDaysBefore` days (default 2, max 14; `0` means same-day only). Set it in `config/pattern.json`. Only **confirmed** shifts are reminded about — an auto-roster proposal never is, on purpose. A volunteer who hands a shift back and reclaims the same one will not get a second reminder. |
| The season export opens as one long column | Your spreadsheet is splitting on a different list separator than the file uses. Set `export.csvDelimiter` in `config/pattern.json` — `";"` for a spreadsheet on a Danish or German locale, `","` for Google Sheets, LibreOffice or a script. Nothing else needs changing; it is one line and takes effect on restart. |
| Danish letters in the export look like `SÃ¸ren` | That would mean the byte-order mark is missing from the file. The export writes one deliberately, because a downloaded `.csv` is read from disk where the response's `charset=utf-8` cannot help, and without the mark a spreadsheet on Windows decodes it in the system codepage. If you see this, the file has been re-saved by something in between — check whatever opened it first. |
| The plan looks lopsided after auto-roster | Open **How the season is spread** on the planning screen. It lists everyone busiest-first, flags anyone whose shifts nearly all fall on one weekday, and names the volunteers who have been given nothing. See **Is the auto-roster fair?** below. |

## What version is this, and what would make it 1.0.0

**`1.0.0-rc.2`.** `/status` shows it as its last line, which is the answer to the first question any support
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
4. **Some configuration values are still unanswered** — how long a shift runs <!--ph:eventMinutes--> and
   whether volunteers read Danish or English <!--ph:locale-->. Each is marked as a placeholder where it is set
   in `config/pattern.json`, which is the list; only 4water can answer them. `README.md` says what each costs.

   Three things this entry used to name are **settled and no longer blockers.** **How many Sunday slots there
   are** was answered by 4water on 2026-08-23: four one-hour slots, 13:00–17:00, with Salsa and Bachata running
   simultaneously in each. Note that this EXTENDS the export's stated 13:00–16:00 by an hour rather than
   subdividing it — it is their correction, not a re-reading of the source. The **clock times** are not
   invented: the discovery spec's section 1, read from the real export, states Wednesdays 19:00 and 20:15 and
   Sundays 13:00–16:00, so they were sourced all along — `config/pattern.json` says so in its own comment and
   this list went on repeating the opposite. And **`board.cutoffDays`** was settled by 4water at `7`; `2` was
   the placeholder while the question was open. Both were listed here as open work, which made the remaining
   distance to 1.0.0 look longer than it is.

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
- **The version the container ships now DOES run the suite, on every push.** _Corrected 2026-08-17._ This
  bullet used to open "⚠ The version the container ships has never run the suite — every test run in this
  project has been on Node 24" and close "That is a good argument, not a green build. **The first CI run on
  22.14 is the actual evidence.**" That evidence exists: every green CI run covers `test (22.14)` alongside
  `test (24)`, so the runtime that matters in production is exercised on the same commit as the other.
  The argument it replaced is kept because it is still the reason the floor holds between runs: the app touches
  only `exec`, `prepare` and `close` on the database and `run`/`get`/`all` on a statement — the original
  22.5-era surface, nothing added since — and the only SQL construct newer than 2018 is `ON CONFLICT … DO
  UPDATE` (SQLite 3.24, against roughly 3.47 bundled on 22.14). A test enforces that rather than trusting it:
  reach for `iterate`, `db.function` or any other later member and the suite fails telling you the real floor
  has moved above the declared one.
- **CI runs the suite on both the pinned LTS and current Node, and that is now a fact rather than a plan.**
  _Corrected 2026-08-17._ This bullet read "has never actually run, because this repository has no remote yet"
  and ended "Push the repo and confirm the first run is green before relying on this line." The repository has
  had a remote since **2026-08-10** and CI has run 20 times — **13 red, then 7 green**.
  The thirteen reds were not Node's doing, and are worth knowing about: three tests read a file `.gitignore`
  excludes, so they passed only on the machine that wrote them, and the failures were unreadable without a
  signed-in session with repo admin — which is why nobody noticed for days. Both are fixed, the suite is
  verified against an actual `git clone` rather than this working copy, and a red build is now a real finding.
  Why this line survived after README.md had already corrected the same claim: **no mechanical check covers a
  negative claim.** One does now — see `test/docs.test.mjs`.

  All four steps have now been exercised, so a red first build should be triaged as a real finding rather than
  as untested scaffolding. The first two (`node --version`, `node --test`) ran against a real clone. The last
  two are Linux shell wrappers — a backgrounded server, a polling `curl`, and two `node -e` snippets — and their
  logic has been run end to end under `bash`, with only the literal `/tmp` prefix substituted, because a Node
  binary on Windows resolves `/tmp/ci.db` to `C:\tmp\ci.db`. That exercised the parts that could plausibly be
  wrong: the `head -c 32 /dev/urandom | od | tr` secret really is one the app accepts, the three-variable
  continuation line parses, the health poll returns `ok`, `require('node:sqlite')` works inside `node -e` in a
  project that is otherwise ESM, and step 4's `FOURWATER_BACKUP_DIR` and `--no-upload` are both real. Step 3
  reported 102 seeded sessions and step 4 a sound integrity check, both exit 0. What is still unverified is
  only the runner itself and the `/tmp` literal.

  Worth knowing if you ever run those two steps by hand: the first attempt reported both as failing, and the app
  had nothing to do with it — `bash.exe` had been launched without MSYS's own `bin` on `PATH`, so `mkdir`, `head`
  and `seq` were all missing and the database was never created. A confident failure of the harness. Read the
  top of the output, not the exit code.
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
- **Sign-in only ever sends people to pages of this app.** A volunteer who taps a notification link without a
  session is bounced to `/signin?next=/board`, and after signing in they land on the board rather than the home
  page. The destination is accepted **only if it matches a route this app registered** — not filtered for anything
  that looks dangerous, but checked against the real route table, so `//somewhere-else`, an absolute URL and
  `/board/../admin` are all refused for the same reason. If somebody ever "improves" this into a pattern match, it
  becomes an open redirect: a link that looks like your sign-in page and ends up somewhere else. Eighteen attempts
  are in `test/nextdest.test.mjs`, alongside the control that proves a legitimate destination still works.

## Who to call

- Copenhagen scheduling: the 4water Copenhagen board.
- The host and container: 4water Lyon's technical volunteers.
- The code: this repository. `npm test` runs everything and needs no network, no database and no setup.

Any decision that looks arbitrary is probably explained in the discovery document ("4water scheduling — spec",
which is not part of this repository — ask whoever handed this over), and the build order
in `PLAN.md`.
