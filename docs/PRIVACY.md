# Personal data in this app — a draft for the board to confirm

This answers spec question Q16. **It is a description of what the software does plus a suggested position —
not legal advice, and not yet a decision.** The board needs to confirm the controller, the lawful basis and
the retention period; the rest is factual and can be checked against the code.

## What is stored, and where it comes from

| Data | Table | Source |
|---|---|---|
| Name | `people.name` | admin, or a NextCloud profile on first sign-in |
| Contact address | `people.contact` | admin, or an invitation |
| Which activities someone can run | `capabilities` | admin |
| Which of the four roles they hold | `person_roles` | admin |
| Which dates and hours they can help | `availability_day`, `availability_hour` | the volunteer, about themselves |
| Which slots they took | `assignments` | the volunteer, a planner, or auto-roster |
| Sign-in linkage | `people.auth_provider`, `auth_subject` | derived on first sign-in |
| Invitation addresses | `invitations.email` | admin |
| Messages sent about them | `notifications.body` | generated |
| Calendar-feed credential | `people.calendar_token_hash` | the volunteer, if they ask for a feed |
| Whether they turned up to a shift | `assignments.attended` | a planner, afterwards |
| Who changed the plan or a person's record | `audit.actor_name`, `actor_id`, `detail` | derived from the action |
| Notes written on a shift | `notes.body`, `notes.author_name`, `notes.person_id` | a volunteer, in their own words |

**The calendar feed deserves its own paragraph**, because it is the one place this app hands out a URL that
works without signing in. A calendar client cannot present a session, so the link itself is the credential.
The consequences are deliberate, and all of them are stated to the volunteer on their own page and in the
in-app privacy notice rather than left to be discovered:

- Only a **SHA-256 hash** is stored, exactly as for invitations. A copy of the database does not yield working
  calendar URLs.
- The raw link is shown **once**, when it is created, and cannot be recovered afterwards — only replaced.
- **Anyone holding the link can read that volunteer's shifts.** Not the whole plan and nothing else about
  them, but that much. It is theirs to replace or switch off at any time, and both take effect immediately.
- A feed contains only that person's own assignments. It is not a second route to the roster.
- **Erasure destroys the credential.** Anonymising also marks the row inactive, which by itself would already
  stop the feed serving — but that would leave a live secret in the database, so `erasePerson` nulls it.

**Attendance is recorded, and this document said the opposite for one commit.** The sentence below used to
read "no attendance or performance records", which stopped being true the moment 4water asked for the
contribution figure to count activities *attended* rather than merely taken. Stating it plainly instead:

- A planner marks, **after the shift**, whether the person turned up. Three states, one of which is *nobody
  has said* — the honest default, and not the same as a no-show.
- It is **a statement by one person about another**, so it is audited: `planner.attendance` records who marked
  it and what they marked, and a planner can change it back. The app refuses to record attendance for a shift
  that has not happened yet.
- What it feeds is the **contribution record** — "how many activities has this person actually run this
  season". It deliberately does **not** feed eligibility, auto-roster balancing, or the *active* flag; those
  read the count of shifts held, for reasons written up in PLAN.md. **Nobody is excluded from anything by an
  attendance figure.**
- If the board would rather not hold it, this is one nullable column and one screen, and removing it costs
  nothing else.

**Free text arrived, and it is a step change rather than a feature.** 4water asked for "a chat system of sorts",
and the app now has short notes attached to a shift — "bring the speaker", "I will be ten minutes late". This
paragraph used to say the app kept *no free-text notes about people*, and the board should understand exactly what
changed, because free text is the one kind of personal data that cannot be erased field by field:

- A note is **at most 280 characters**, deliberately, so that this stays a margin note and not a correspondence
  archive nobody can honour a request against.
- Every signed-in volunteer can read the notes on a shift. That is a decision for an association of forty people
  who already share a chat channel, and it is the point: a note nobody can see would not be worth writing.
- **Nobody can edit anybody's words**, including their own. A note somebody has read and acted on must not change
  under them; a correction is a second note.
- **Erasure deletes that person's own notes outright**, rather than relabelling them as it does audit rows. An
  audit row is a record *of* an action and still answers "who did this" under a `#id` label; a note is the person's
  own sentence, and there is no version of it with the person taken out.
- **What erasure cannot do is find somebody's name inside another volunteer's note.** No software can do that
  reliably, and it is more honest to say so than to imply completeness. What bounds it is retention: notes belong to
  a session, so they are deleted with the season under `retention.seasons`.

If the board would rather not hold free text at all, this is one table and one screen, and removing it costs nothing
else.

**What is deliberately NOT stored:** no passwords (sign-in is NextCloud's job or a single-use link), no
payment details, and no analytics or tracking of any kind. There are no third-party scripts — the
Content-Security-Policy forbids them outright.

Roughly 40 volunteers per department. Ordinary contact data, no special categories.

## Suggested position for the board

- **Controller:** 4water Copenhagen (the association), since it decides who is on the roster and why.
- **Processors:** 4water's **Lyon department**, who operate the host — this is an internal arrangement, but it
  is still one part of the organisation processing another's data and should be written down.
  **NextCloud** (sign-in and backup storage) and **Mattermost** (notifications), both self-hosted by 4water,
  so no external processor is involved unless that changes.
- **Lawful basis:** *legitimate interest* — a volunteer organisation cannot schedule volunteers without
  knowing who they are and when they are free. Consent is a poor fit: withdrawing it would have to mean
  leaving the rota, which makes the consent less than free.
- **Retention:** **two seasons of history, then delete**, which keeps "is this person active" answerable across
  a boundary without accumulating years of who-taught-what. Implemented and configurable in
  `config/pattern.json` under `retention`; it runs as part of the nightly backup, so it is only as reliable as
  that cron line. Notifications and invitations are bounded separately, by days rather than seasons.
- **Transfers:** none outside the EU, provided the host stays in the EU. Worth confirming where Lyon's server
  physically is.

## Rights, and how to actually service them

Each of these names the route that services it, so the claim is checkable rather than a promise —
`test/docs.test.mjs` fails if any route named here is not registered. This section previously said access had "no
export button yet" and that erasure was "not implemented", while the gap list a few lines below already recorded
both as closed. It contradicted itself, in the part a board reads to answer whether a subject access request can
actually be serviced.

- **Access / portability:** a volunteer downloads their own data at `GET /me/export.json`; an admin fetches
  anybody's at `GET /admin/person/:id/export.json`. JSON, one person per file, and it covers **every table listed in
  "What is stored" above** — identity, roles, capabilities, every availability answer, every assignment, the messages
  the app has sent about them, any notes they wrote, any invitation addressed to them, and the actions they
  themselves took from the change log. That completeness is enforced rather than promised: a test seeds a row for one
  person in every table the schema holds personal data in and fails if the export comes back without it, so a table
  added later cannot quietly fall out of a subject access request. It was added because three had — notes, the change
  log and invitations were held by the app and missing from the file, while erasure had known about all three all
  along.
  **What the file deliberately does not contain:** the calendar credential or an invitation token (whether a feed is
  enabled is theirs to know; the token would only be a liability in a downloaded file), and change-log rows where
  somebody *else* acted on them — those are largely about the other person, and an administrator's identity is not
  the requester's to receive. Rows recording what the requester did themselves include the full detail, since there
  is nothing there they did not see at the time. A whole season is also exportable as a spreadsheet at
  `GET /planner/season.csv`.
- **Rectification:** a volunteer edits their own name, contact and dance role on their own page; an admin edits
  anyone's from Administration. Availability is always the volunteer's own.
- **Erasure:** Administration → a person → Erase, in **two modes, because only the board can choose between
  them.** *Anonymise* keeps who-taught-what under an unidentifiable label and strips name, contact, dance role,
  sign-in linkage and the calendar credential — history survives as "somebody". *Remove* deletes the row, and the
  schema's `ON DELETE CASCADE` / `SET NULL` takes capabilities, availability and roles with it while leaving the
  assignments as unattributed. The last administrator cannot be erased, so the app cannot be locked out by a
  deletion.
  **The audit trail is the one place rows are kept on purpose**, and the board should know why: deleting it
  would mean nobody could ever answer "who stood this volunteer down, and when". Erasure takes the *identity*
  out of it instead — the actor's name becomes the same `#id` label used elsewhere, and any address written
  into a row's detail is swept out. So the log still says a person did a thing, and no longer says which
  person. Both erasure modes do this. It is a bargain rather than a clean answer, and it is the board's to
  reject: the alternative is an audit trail with holes in it wherever somebody has left.
- **Restriction:** marking someone inactive stops them being offered or assigned anything while keeping their
  record — which is the right default for a rota, and is *not* erasure. It is listed separately here precisely
  because this document once conflated the two.
- **Objection:** in practice, leaving the rota; an admin marks the person inactive or erases them.

## Honest gaps

**This section was itself out of date, which is worth saying plainly at the top of it.** Four of the five gaps
listed here were closed by later work, and the document went on telling the board that nothing was ever
deleted, that there was no erasure, and that volunteers were never told anything. A privacy document that
understates what the software does is a smaller problem than one that overstates it, but it is the same defect:
a confident claim nobody checked. What follows is the current state.

**Closed:**

1. ~~No retention job.~~ `runRetention` prunes notifications older than the configured window, invitations that
   are spent or dead, and seasons beyond the keep count. It runs from `tools/backup.mjs`, so the nightly cron
   line in RUNBOOK is what makes it happen — **if that line is not installed, nothing is deleted.** The
   `retention.seasons` default of two is honoured; a zero or a typo falls back to the default rather than deleting
   everything.
2. ~~No erasure button.~~ Administration → a person → Erase, in two modes. *Anonymise* keeps who-taught-what
   with an unidentifiable label and strips name, contact, dance role, sign-in linkage and the calendar
   credential; *remove* deletes the row. The last administrator cannot be erased.
4. ~~`notifications.body` is unbounded.~~ Bounded by `retention.notificationDays`, default 90.
5. ~~No privacy notice shown to volunteers.~~ A short notice is linked from the availability screen and the
   volunteer's own page, and it covers the calendar link explicitly.

**Still true, and not fixable in code:**

3. **Backups extend retention.** Fourteen daily copies live in the volume and on NextCloud, so a deletion is
   not fully effective for a fortnight. Normal, and worth stating rather than hiding.

**Newly known:**

6. **Retention depends on an operator installing a cron line.** The app cannot schedule it — deliberately, since
   a container that deletes data on a timer nobody configured is worse. But it means "deleted automatically" is
   true of the software and conditional on the deployment. Check `/status` for the backup age: if backups are
   not running, retention is not either.
7. **An invitation address outlives the invitation by design, briefly.** A spent invite is kept for the
   retention window rather than deleted on acceptance, so an admin can still see recent activity on the
   Administration screen. Shorten `retention.notificationDays` if the board prefers otherwise.

## Security measures that bear on this

Server-rendered pages with a strict CSP and no third-party requests; sessions in an HMAC-signed
`HttpOnly; SameSite=Lax; Secure` cookie with no server-side store; CSRF token on every state-changing request;
every page and export that carries personal data is sent `Cache-Control: no-store`, so a shared computer's
browser cannot re-display the roster from cache after somebody signs out;
invite tokens stored only as SHA-256 hashes; the container runs unprivileged with memory and CPU limits;
backups refuse to be written into a git work tree or a cloud-sync folder, because the file is the whole
roster. Details in `../RUNBOOK.md` and the code.
