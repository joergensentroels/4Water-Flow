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
| Which dates and hours they can help | `availability_day`, `availability_hour` | the volunteer, about themselves |
| Which slots they took | `assignments` | the volunteer, a planner, or auto-roster |
| Sign-in linkage | `people.auth_provider`, `auth_subject` | derived on first sign-in |
| Invitation addresses | `invitations.email` | admin |
| Messages sent about them | `notifications.body` | generated |
| Calendar-feed credential | `people.calendar_token_hash` | the volunteer, if they ask for a feed |

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

**What is deliberately NOT stored:** no passwords (sign-in is NextCloud's job or a single-use link), no
payment details, no attendance or performance records, no free-text notes about people, and no analytics or
tracking of any kind. There are no third-party scripts — the Content-Security-Policy forbids them outright.

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

- **Access / portability:** everything about one person is reachable by their `people.id`. There is no export
  button yet; a planner can answer a request by hand from the admin screen, which is proportionate at this
  size but is a gap if anyone asks formally.
- **Rectification:** the admin screen; volunteers edit their own availability.
- **Erasure:** ⚠ **not implemented.** Marking someone inactive keeps their history, which is the right default
  for a rota but is not erasure. Deleting a person cascades to capabilities, availability and roles, and sets
  their assignments to NULL — so history survives as "somebody" rather than being destroyed. That behaviour is
  in the schema (`ON DELETE CASCADE` / `SET NULL`) but there is no button, and the choice between it and full
  removal is the board's, not the developer's.
- **Objection:** in practice, leaving the rota.

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
   two-season default is honoured; a zero or a typo falls back to the default rather than deleting everything.
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
invite tokens stored only as SHA-256 hashes; the container runs unprivileged with memory and CPU limits;
backups refuse to be written into a git work tree or a cloud-sync folder, because the file is the whole
roster. Details in `../RUNBOOK.md` and the code.
