// Notes on a session — the small amount of talking a rota needs.
//
// 4water asked for "a chat system of sorts". Three shapes were possible and this is the one built, with the reason
// written down because it was my call rather than theirs:
//
//   1. A general chat. NOT built: Mattermost already runs with the same NextCloud sign-in, and a second place to
//      talk would split the conversation and be worse than either half.
//   2. A planner broadcast. Not built YET, and this is deliberately the substrate for it: a broadcast is a note
//      with no session attached, so it reuses this table, this page and the erasure and retention work below.
//   3. Notes attached to a shift. Built. It is the thing a channel cannot do — "bring the speaker" belongs beside
//      Wednesday's class, not eleven messages up a scroll.
//
// The whole model is append-and-delete-your-own. No editing: a note somebody has read and acted on should not
// change under them, and "I edited it" is a worse answer to a mistake than a second note. No threading, no
// reactions, no read receipts — this is a margin, not a product.
import { html } from "./http.mjs";
import { csrfField } from "./views.mjs";

// 280 characters, and the number is a decision rather than a round figure. It has to be long enough for "I will be
// ten minutes late, start the warm-up without me" and short enough that nobody mistakes this for a place to keep
// records about a person — which matters because free text cannot be erased field by field. See db.mjs.
export const NOTE_MAX = 280;

export const listNotes = (db, sessionId) => db.prepare(`
  SELECT n.id, n.at, n.body, n.person_id AS personId, n.author_name AS authorName
    FROM notes n WHERE n.session_id = :sid ORDER BY n.at, n.id
`).all({ sid: sessionId });

// How many notes each of these sessions has, so a list can show "2 notes" without loading the bodies. One query for
// the whole page: the per-row alternative is the N+1 this project has fixed twice.
export function noteCounts(db, sessionIds) {
  if (sessionIds.length === 0) return new Map();
  const marks = sessionIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT session_id AS sid, COUNT(*) AS n FROM notes
                            WHERE session_id IN (${marks}) GROUP BY session_id`).all(...sessionIds);
  return new Map(rows.map((r) => [r.sid, r.n]));
}

// `authorName` is stored as written, for the same reason the audit stores the actor's name: a hard erasure removes
// the person row, and a note signed by nobody is worse than one signed by a label.
export function addNote(db, sessionId, { personId, authorName, body, at = new Date() }) {
  const text = String(body ?? "").trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, reason: "empty_note" };
  if (text.length > NOTE_MAX) return { ok: false, reason: "note_too_long" };
  if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) return { ok: false, reason: "no_such_session" };

  const { id } = db.prepare(`INSERT INTO notes (session_id, person_id, author_name, body, at)
                             VALUES (:sid, :pid, :name, :body, :at) RETURNING id`)
    .get({ sid: sessionId, pid: personId ?? null, name: String(authorName ?? "").trim() || "system",
           body: text, at: at.toISOString() });
  return { ok: true, id };
}

// Deleting your own. A note is somebody's words, so the person who wrote it may remove it — and nobody else may,
// which is why this takes the person and not just the note.
export function deleteNote(db, noteId, personId) {
  const row = db.prepare("SELECT person_id AS personId FROM notes WHERE id=?").get(noteId);
  if (!row) return { ok: false, reason: "no_such_note" };
  if (row.personId !== personId) return { ok: false, reason: "not_your_note" };
  db.prepare("DELETE FROM notes WHERE id=?").run(noteId);
  return { ok: true };
}

// Erasure's half. DELETED rather than pseudonymised, unlike the audit trail, and the asymmetry is the point: an
// audit row is a record OF an action and keeping it under a label still answers "who did this". A note is the
// person's own sentence, and there is no version of it with the person taken out. So the right to erasure over free
// text is only satisfiable by removing the text.
//
// What this CANNOT do is find somebody's name inside another volunteer's note. docs/PRIVACY.md says so plainly
// rather than implying a completeness that is not available.
export const deleteNotesBy = (db, personId) =>
  db.prepare("DELETE FROM notes WHERE person_id = ?").run(personId).changes;

// The rendered thread. Kept here beside the queries because the shape is trivial and splitting it would mean two
// files to read for eight lines of markup.
export const noteList = (t, notes, { me, session, formatWhen }) => notes.length === 0
  ? html`<p class="empty">${t("notes.none")}</p>`
  : html`<ul class="notes">${notes.map((n) => html`
      <li>
        <p class="notemeta"><b>${n.authorName}</b> · <time datetime="${n.at}">${formatWhen(n.at)}</time></p>
        <p class="notebody">${n.body}</p>
        ${n.personId != null && n.personId === me ? html`
          <form method="post" action="/note/${n.id}/delete" class="inline">
            ${csrfField(session)}
            <button type="submit" class="secondary" aria-label="${t("notes.delete")} — ${n.body.slice(0, 40)}">${
              t("notes.delete")}</button>
          </form>` : ""}
      </li>`)}</ul>`;
