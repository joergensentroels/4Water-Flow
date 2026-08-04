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
- **Retention:** suggest **two seasons of history, then delete**. That keeps "is this person active" answerable
  across a boundary while not accumulating years of who-taught-what. ⚠ Not implemented — see below.
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

1. **No retention job.** Nothing deletes anything, ever. The suggested two-season rule needs implementing —
   the natural place is alongside the nightly backup.
2. **No erasure button.** See above. Doing it properly needs a decision about whether past assignments keep a
   name.
3. **Backups extend retention.** Fourteen daily copies live in the volume and on NextCloud, so a deletion is
   not fully effective for a fortnight. This is normal and worth stating rather than hiding.
4. **`notifications.body` contains names** (a nudge is addressed to someone). It is capped only by the app's
   own retention of that table, which is currently unbounded — the same gap as (1).
5. **No privacy notice shown to volunteers.** They should be told what is held and why, ideally on the
   availability screen where they first enter data. A sentence and a link would do it.

## Security measures that bear on this

Server-rendered pages with a strict CSP and no third-party requests; sessions in an HMAC-signed
`HttpOnly; SameSite=Lax; Secure` cookie with no server-side store; CSRF token on every state-changing request;
invite tokens stored only as SHA-256 hashes; the container runs unprivileged with memory and CPU limits;
backups refuse to be written into a git work tree or a cloud-sync folder, because the file is the whole
roster. Details in `../RUNBOOK.md` and the code.
