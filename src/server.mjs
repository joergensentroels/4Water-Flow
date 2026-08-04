// Wiring. Routes live here; the work lives in src/pages/*. Exported as buildApp() so tests can run the real
// server on an ephemeral port rather than a mock — the bugs worth catching are in the plumbing.
import { pathToFileURL } from "node:url";
import { createApp, send, redirect, readForm, html } from "./http.mjs";
import { loadPattern, makeT, PATTERN_FILE, patternFileFor, calendarConfig } from "./config.mjs";
import { openDb, migrate } from "./db.mjs";
import { readSession, sign, cookieHeader, clearCookieHeader, newCsrf, checkCsrf, sessionSecret } from "./session.mjs";
import { rolesOf, requireRole, devSignIn, assertDevAllowed, oidcConfig, beginOidc, discoverOidc, checkState, completeOidc,
         linkIdentity, redeemInvite, createInvite, revokeInvite } from "./auth.mjs";
import { layout, navFor, formatDate, formatTime, formatRole, renderErrorPage, renderPrivacy } from "./views.mjs";
import { slotOpenMessage, notifyConfig, makeNotifier } from "./notify.mjs";
import { startJobs } from "./jobs.mjs";
import { datesNeedingAnswer, currentAnswers, renderAvailability, saveAvailability, bulkTargets } from "./pages/availability.mjs";
import { renderHome, renderPlan } from "./pages/plan.mjs";
import { renderBoard, flashFor } from "./pages/board.mjs";
import { renderPlanner, plannerFlash } from "./pages/planner.mjs";
import { autoRoster, lockInProposals, discardProposals, countProposals } from "./roster.mjs";
import { renderAdmin, adminFlash } from "./pages/admin.mjs";
import { peopleWithDetail, PEOPLE_PAGE, invitesWithDetail, setRole, setCapability, setPersonStatus,
         savePattern, patternFromForm, addActivityToForm, proposeNextSeason,
         addWeeklyToForm, removeWeeklyFromForm, sessionsForSlot } from "./admin.mjs";
import { seedSeason } from "./seed.mjs";
import { makeLimiter, clientKey } from "./ratelimit.mjs";
import { erasePerson, exportPerson, exportSeasonCsv, runRetention } from "./retention.mjs";
import { myProfile, saveProfile, renderProfile, profileFlash } from "./pages/profile.mjs";
import { collectStatus, renderStatus } from "./pages/status.mjs";
import { listOutbox, renderOutbox } from "./pages/outbox.mjs";
import { backupConfig } from "../tools/backup.mjs";
import { myUpcoming, planForSeason, score, openSlotsFor, claimSlot, handBackSlot,
         eligiblePeopleFor, assignSlot, unassignSlot, calendarRowsFor, boardEmptyReason, slotEmptyReason } from "./queries.mjs";
import { buildIcs, calendarTokenFor, revokeCalendarToken, hasCalendarToken,
         personByCalendarToken } from "./calendar.mjs";

// `today` is a single injected clock for the whole app: "upcoming" here, the hand-back cutoff in the board,
// and the nudge window later all need one, and three separate calls to new Date() is how those drift apart
// in tests. Returns an ISO date string because everything stored is a date, not an instant.
// `patternFile` is injectable so a test never rewrites the repository's own config. Without it, running the
// admin suite would silently edit config/pattern.json — a test that damages the thing it is testing.
export function buildApp({ db, pattern = loadPattern(), env = process.env, notifier = null,
                           patternFile = PATTERN_FILE,
                           today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const secret = sessionSecret(env);
  const secure = env.NODE_ENV === "production";
  const oidc = oidcConfig(env);
  const devAuth = env.FOURWATER_AUTH === "dev" && env.NODE_ENV !== "production";

  // Deliberately mutable: the admin screen edits config/pattern.json, and the running process must pick that
  // up immediately. Telling an admin to restart the server would be the same class of failure as a cached
  // credential that only looks rotated — the file says one thing while the process believes another.
  let cfg = pattern;
  let t = makeT(cfg.locale);
  const reloadPattern = (next) => { cfg = next; t = makeT(cfg.locale); };
  const seasonId = () => db.prepare("SELECT id FROM seasons WHERE key = ?").get(cfg.season.key)?.id ?? null;

  // Throttle for the two endpoints reachable without a session. An alarm, not a lock — see ratelimit.mjs.
  const limiter = makeLimiter();
  setInterval(() => limiter.sweep(), 60_000).unref?.();

  // Error pages need the layout and the current locale, both of which live here rather than in the router.
  const app = createApp({ renderError: (status) => renderErrorPage(t, status) });

  // Every request resolves a session once. A fresh CSRF token is minted for anyone without one, so the
  // token is bound to the session rather than kept in a server-side map.
  const ctx = (req) => {
    const session = readSession(req, secret) ?? null;
    const roles = session?.personId ? rolesOf(db, session.personId) : [];
    return { session, roles };
  };
  const setSession = (data) => cookieHeader(sign({ ...data, csrf: newCsrf() }, secret), { secure });

  // Guard used by every authenticated route: returns a response instead of a boolean, so a handler cannot
  // forget to stop after a failed check.
  const gate = ({ req, res }, role = null) => {
    const { session, roles } = ctx(req);
    const g = requireRole(db, session, role);
    if (!g.ok) {
      if (g.status === 401) { redirect(res, "/signin"); return null; }
      send(res, 403, renderErrorPage(t, 403));
      return null;
    }
    return { session, roles, personId: g.personId, who: db.prepare("SELECT name FROM people WHERE id=?").get(g.personId)?.name ?? "" };
  };

  // POST guard. A missing or wrong CSRF token is a 403 with a human explanation, because the honest common
  // cause is a form left open overnight, not an attack.
  const postGate = async ({ req, res }, role = null) => {
    const c = gate({ req, res }, role);
    if (!c) return null;
    const form = await readForm(req);
    if (!checkCsrf(c.session, form.csrf)) {
      send(res, 403, renderErrorPage(t, 403, { messageKey: "error.csrf" }));
      return null;
    }
    return { ...c, form };
  };

  app.get("/healthz", ({ res }) => send(res, 200, "ok", { "Content-Type": "text/plain; charset=utf-8" }));

  // ---- sign in ----------------------------------------------------------------------------------------
  app.get("/signin", ({ req, res, query }) => {
    const { session } = ctx(req);
    if (session?.personId) return redirect(res, "/");
    const people = devAuth ? db.prepare("SELECT id, name FROM people ORDER BY name LIMIT 25").all() : [];
    const body = html`
      <h2>${t("signin.title")}</h2>
      ${query.get("unknown") ? html`<p class="flash bad">${t("signin.unknown")}</p>` : ""}
      ${oidc.enabled ? html`<p><a class="btn" href="/auth/oidc">${t("signin.nextcloud")}</a></p>` : ""}
      <p class="hint">${t("signin.invite")}</p>
      ${devAuth ? html`
        <div class="card">
          <h2>${t("signin.dev")}</h2>
          <form method="post" action="/auth/dev">
            ${people.map((p) => html`<p><button type="submit" name="personId" value="${p.id}" class="secondary">${p.name}</button></p>`)}
          </form>
        </div>` : ""}`;
    send(res, 200, layout({ t, title: t("signin.title"), body }));
  });

  // The dev sign-in has no CSRF token because there is no session yet. It is gated by assertDevAllowed(),
  // which throws under NODE_ENV=production — the route simply does not function in a real deployment.
  // REGISTERED ONLY WHEN ALLOWED, so in production the route does not exist and the router answers 404.
  // It used to be registered unconditionally and rely on assertDevAllowed throwing, which refused correctly —
  // no session was issued — but answered 500. That is the wrong answer three ways: it reads as "the server
  // broke" rather than "there is no such thing here", it files an error in the log for what is actually the
  // safety posture working, and it tells anyone probing that the route exists and blew up. The assert stays
  // inside as well, so that making registration unconditional again cannot quietly re-open it.
  if (devAuth) app.post("/auth/dev", async ({ req, res }) => {
    assertDevAllowed(env);
    const form = await readForm(req);
    const who = devSignIn(db, form.personId, env);
    if (!who) return redirect(res, "/signin?unknown=1");
    redirect(res, "/", { "Set-Cookie": setSession({ personId: who.personId }) });
  });

  // async because the authorization endpoint now comes from the IdP's discovery document rather than a
  // hardcoded NextCloud path. The document is cached, so this is one request per issuer per 10 minutes.
  app.get("/auth/oidc", async ({ res }) => {
    const { url, state, verifier } = await beginOidc(oidc);
    // state and verifier ride in the session cookie: no server-side store, and they are signed, so a
    // callback cannot be replayed with attacker-chosen values.
    redirect(res, url, { "Set-Cookie": cookieHeader(sign({ oidcState: state, oidcVerifier: verifier, csrf: newCsrf() }, secret), { secure, maxAge: 600 }) });
  });

  app.get("/auth/callback", async ({ req, res, query }) => {
    const key = clientKey(req);
    if (limiter.blocked(key)) return send(res, 429, renderErrorPage(t, 429), { "Retry-After": "600" });
    const { session } = ctx(req);
    if (!session?.oidcState || !checkState(session.oidcState, query.get("state") ?? "")) {
      limiter.fail(key, "oidc-state");
      return send(res, 400, renderErrorPage(t, 400));
    }
    const id = await completeOidc(oidc, { code: query.get("code") ?? "", verifier: session.oidcVerifier });
    const person = linkIdentity(db, "oidc", id.subject, { name: id.name, email: id.email });
    if (!person) return redirect(res, "/signin?unknown=1", { "Set-Cookie": clearCookieHeader({ secure }) });
    redirect(res, "/", { "Set-Cookie": setSession({ personId: person.personId }) });
  });

  app.get("/invite/:token", ({ req, res, params }) => {
    const key = clientKey(req);
    if (limiter.blocked(key)) return send(res, 429, renderErrorPage(t, 429), { "Retry-After": "600" });
    const r = redeemInvite(db, params.token, {});
    if (!r.ok) {
      limiter.fail(key, "invite");
      return redirect(res, "/signin?unknown=1");
    }
    limiter.succeed(key);
    redirect(res, "/availability", { "Set-Cookie": setSession({ personId: r.personId }) });
  });

  app.post("/signout", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    redirect(res, "/signin", { "Set-Cookie": clearCookieHeader({ secure }) });
  });

  // ---- availability (increment B) ----------------------------------------------------------------------
  app.get("/availability", ({ req, res, query }) => {
    const c = gate({ req, res });
    if (!c) return;
    const sid = seasonId();
    send(res, 200, renderAvailability({
      t, session: c.session, roles: c.roles, who: c.who,
      rows: sid ? datesNeedingAnswer(db, sid) : [],
      answers: currentAnswers(db, c.personId),
      flash: query.get("saved") ? { text: t("availability.saved") }
            : query.get("bulk") ? { text: t("availability.bulkDone", { n: query.get("bulk") }) } : null,
    }));
  });

  app.post("/availability", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const sid = seasonId();
    if (sid) saveAvailability(db, c.personId, c.form, sid);
    redirect(res, "/availability?saved=1");
  });

  // Bulk answer. Builds the same field names the per-date form posts and hands them to the SAME writer, so
  // there is one place that validates a date and one place that writes — a second writer here would be
  // where the "fabricated date" guard quietly stopped applying.
  app.post("/availability/bulk", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const sid = seasonId();
    if (!sid) return redirect(res, "/availability");
    const rows = datesNeedingAnswer(db, sid);
    const { rows: targets, value } = bulkTargets(rows, { scope: String(c.form.scope ?? ""), value: String(c.form.value ?? "") });
    if (targets.length === 0) return redirect(res, "/availability");
    const synthetic = Object.fromEntries(targets.map((r) => [`slot:${r.date}:${r.hour}`, value]));
    saveAvailability(db, c.personId, synthetic, sid);
    redirect(res, `/availability?bulk=${targets.length}`);
  });

  // The privacy notice volunteers are pointed at from the screen where they first enter personal data.
  app.get("/privacy", ({ req, res }) => {
    const { session, roles } = ctx(req);
    send(res, 200, renderPrivacy({ t, roles, signedIn: Boolean(session?.personId) }));
  });

  // ---- read-only views (increment C) -------------------------------------------------------------------
  app.get("/", ({ req, res }) => {
    const c = gate({ req, res });
    if (!c) return;
    const sid = seasonId();
    send(res, 200, renderHome({
      t, session: c.session, roles: c.roles, who: c.who,
      mine: sid ? myUpcoming(db, c.personId, sid, today()) : [],
      score: sid ? score(db, c.personId, sid) : 0,
    }));
  });

  app.get("/plan", ({ req, res }) => {
    const c = gate({ req, res });
    if (!c) return;
    const sid = seasonId();
    send(res, 200, renderPlan({ t, roles: c.roles, who: c.who, personId: c.personId, rows: sid ? planForSeason(db, sid) : [] }));
  });

  // ---- the vagtbørs (increment D) ----------------------------------------------------------------------
  app.get("/board", ({ req, res, query }) => {
    const c = gate({ req, res });
    if (!c) return;
    const sid = seasonId();
    const open = sid ? openSlotsFor(db, c.personId, sid, today()) : [];
    send(res, 200, renderBoard({
      t, session: c.session, roles: c.roles, who: c.who,
      open,
      mine: sid ? myUpcoming(db, c.personId, sid, today()) : [],
      // Only diagnosed when there is nothing to show: a handful of counts, and no reason to run them on the
      // common path where the volunteer has slots to look at.
      emptyReason: open.length === 0 && sid ? boardEmptyReason(db, c.personId, sid, today()).reason : null,
      flash: flashFor(t, query.get("r")),
    }));
  });

  app.post("/board/:id/claim", async ({ req, res, params }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const r = claimSlot(db, Number(params.id), c.personId);
    // Always redirect back to the board: the outcome is a message on the page the volunteer is already
    // looking at, and a 303 means a refresh cannot claim twice.
    redirect(res, `/board?r=${r.ok ? "claimed" : r.reason}`);
  });

  app.post("/slot/:id/hand-back", async ({ req, res, params }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const id = Number(params.id);
    // Read the slot's details BEFORE releasing it: afterwards person_id is null and the announcement would
    // have nothing to name.
    const detail = db.prepare(`
      SELECT s.date, t.hour, t.minute, act.label, a.role
        FROM assignments a JOIN sessions s ON s.id=a.session_id
        JOIN timeslots t ON t.id=s.timeslot_id JOIN activities act ON act.id=s.activity_id
       WHERE a.id = ?`).get(id);

    const r = handBackSlot(db, id, c.personId, { today: today(), cutoffDays: Number(cfg.board?.cutoffDays) || 0 });
    const code = r.ok ? (r.pastCutoff ? "handed_back_late" : "handed_back") : r.reason;

    // Announce it, and never let that failure reach the volunteer: the slot IS released, and an error page
    // would make them try again. Deliberately not awaited into the response path.
    if (r.ok && detail) announceOpenSlot(id, detail).catch(() => {});
    redirect(res, `/board?r=${code}`);
  });

  // ---- planner grid (increment F) -----------------------------------------------------------------------
  app.get("/planner", ({ req, res, query }) => {
    const c = gate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    let rows = sid ? planForSeason(db, sid).filter((r) => r.date >= today()) : [];

    // A HORIZON, defaulting to four weeks. Measured at a realistic size — 200 volunteers, six slots a week —
    // the whole-season view rendered 490 KB of HTML, because every open slot carries a dropdown of every
    // eligible person. Half a megabyte on a phone on mobile data is not a planner screen. Four weeks is also
    // simply the right amount of work to look at; the links below extend it when needed.
    const weeks = query.get("weeks") === "all" ? null : Math.max(1, Number(query.get("weeks")) || 4);
    if (weeks) {
      const until = new Date(Date.parse(`${today()}T00:00:00Z`) + weeks * 7 * 86400000).toISOString().slice(0, 10);
      rows = rows.filter((r) => r.date <= until);
    }

    // "Gaps only" is the view a planner actually wants most of the time: the whole season is noise when the
    // question is "what is still unfilled".
    const gapsOnly = query.get("gaps") === "1";
    if (gapsOnly) rows = rows.filter((r) => r.personId == null);

    // Look up candidates only for the open slots on screen — one query per gap, not per row. Gaps are the
    // minority, and the alternative is a single query returning every person for every slot in the season.
    const eligibleByAssignment = new Map();
    // And for the slots that came back with NOBODY, why. Only for those: a season is mostly staffable, so this
    // is a handful of extra queries on the rows a planner is actually stuck on.
    const emptyReasons = new Map();
    for (const r of rows) {
      if (r.personId != null) continue;
      const people = eligiblePeopleFor(db, r.assignmentId);
      eligibleByAssignment.set(r.assignmentId, people);
      if (people.length === 0) emptyReasons.set(r.assignmentId, slotEmptyReason(db, r.assignmentId).reason);
    }

    send(res, 200, renderPlanner({
      t, session: c.session, roles: c.roles, who: c.who, rows, eligibleByAssignment, emptyReasons, gapsOnly, weeks,
      pendingProposals: sid ? countProposals(db, sid, today()) : 0,
      // Counts ride in the query string so the message can say what happened rather than just "done".
      flash: plannerFlash(t, query.get("r"), {
        filled: query.get("filled") ?? 0, gaps: query.get("gaps_n") ?? 0, n: query.get("n") ?? 0,
      }),
    }));
  });

  // ---- auto-roster (increment G) -------------------------------------------------------------------------
  app.post("/planner/auto-roster", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    if (!sid) return redirect(res, "/planner");
    const r = autoRoster(db, { seasonId: sid, fromDate: today() });
    if (r.filled === 0 && r.gaps === 0) return redirect(res, "/planner?r=roster_empty");
    redirect(res, `/planner?r=roster_done&filled=${r.filled}&gaps_n=${r.gaps}`);
  });

  app.post("/planner/proposals/lock", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    const n = sid ? lockInProposals(db, sid, today()) : 0;
    redirect(res, `/planner?r=locked&n=${n}`);
  });

  app.post("/planner/proposals/discard", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    const n = sid ? discardProposals(db, sid, today()) : 0;
    redirect(res, `/planner?r=discarded&n=${n}`);
  });

  app.post("/planner/assign", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const expect = c.form.expect === "" || c.form.expect == null ? null : Number(c.form.expect);
    const r = assignSlot(db, Number(c.form.assignmentId), Number(c.form.personId), { expectPersonId: expect });
    const code = r.ok ? (r.unanswered ? "assigned_unanswered" : "assigned") : r.reason;
    redirect(res, `/planner?r=${code}`);
  });

  app.post("/planner/unassign", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const id = Number(c.form.assignmentId);
    const detail = db.prepare(`
      SELECT s.date, t.hour, t.minute, act.label, a.role
        FROM assignments a JOIN sessions s ON s.id=a.session_id
        JOIN timeslots t ON t.id=s.timeslot_id JOIN activities act ON act.id=s.activity_id
       WHERE a.id = ?`).get(id);
    const r = unassignSlot(db, id, { expectPersonId: c.form.expect ? Number(c.form.expect) : null });
    // A planner freeing a slot puts it on the børs exactly like a volunteer handing it back, so it gets the
    // same announcement — otherwise the two paths would behave differently for no reason a volunteer could see.
    if (r.ok && detail) announceOpenSlot(id, detail).catch(() => {});
    redirect(res, `/planner?r=${r.ok ? "unassigned" : r.reason}`);
  });

  // ---- admin (increment H) -------------------------------------------------------------------------------
  // The raw invite token is shown ONCE, right after creation, and never stored — only its hash is. So it is
  // held in memory keyed by the admin's person id until they navigate away.
  const freshInvites = new Map();
  // Same one-shot pattern for a freshly minted calendar link, and for the same reason: only the hash is
  // stored, so this is the single moment the raw token can be shown. Cleared as soon as it has been rendered.
  const freshCalendarLinks = new Map();

  app.get("/admin", ({ req, res, query }) => {
    const c = gate({ req, res }, "admin");
    if (!c) return;
    const link = freshInvites.get(c.personId) ?? null;
    freshInvites.delete(c.personId);              // shown once, as the label promises
    // Capped by default and searchable. Only "all" and a positive number are honoured; anything else falls back
    // to the page size rather than being passed through to a LIMIT.
    const wanted = query.get("people");
    const roster = peopleWithDetail(db, {
      q: query.get("q") ?? "",
      limit: wanted === "all" ? "all" : Number(wanted) > 0 ? Number(wanted) : PEOPLE_PAGE,
    });
    send(res, 200, renderAdmin({
      t, session: c.session, roles: c.roles, who: c.who,
      people: roster.rows, roster, invites: invitesWithDetail(db), pattern: cfg, inviteLink: link,
      nextSeason: proposeNextSeason(cfg),
      weeklyUse: Object.fromEntries((cfg.weekly ?? []).map((w) => [
        `${w.dayOfWeek}:${w.hour}:${w.minute ?? 0}`,
        seasonId() ? sessionsForSlot(db, seasonId(), w) : 0])),
      flash: adminFlash(t, query.get("r"), { message: query.get("m") ?? "", who: query.get("who") ?? "",
                                             mode: query.get("mode") ?? "", notifications: query.get("notifications") ?? 0,
                                             seasons: query.get("seasons") ?? 0 }),
    }));
  });

  app.post("/admin/invite", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const email = String(c.form.email ?? "").trim();
    if (!email) return redirect(res, "/admin");
    const token = createInvite(db, { email });
    // FOURWATER_BASE_URL, never the Host header.
    //
    // This used to build the absolute URL from req.headers.host, for the good reason that a relative path is
    // useless in an email and hardcoding a domain breaks the second department. But an invite token GRANTS A
    // SESSION, and Host is attacker-influencable: a request with a forged Host renders a link on somebody
    // else's origin, the admin emails it in good faith, and the volunteer clicks it and hands their invite to
    // whoever owns that host. It is the poisoned-password-reset-link attack with extra steps.
    //
    // tools/bootstrap.mjs already used FOURWATER_BASE_URL for exactly this, and so does the calendar feed —
    // this route was the odd one out, and two link builders with two different policies is the tell. When the
    // variable is unset the page shows the path and says to prefix the address, which is the honest answer:
    // the app does not know its own public name unless somebody tells it.
    const base = String(env.FOURWATER_BASE_URL || "").replace(/\/+$/, "");
    freshInvites.set(c.personId, `${base}/invite/${token}`);
    redirect(res, "/admin?r=invited");
  });

  app.post("/admin/invite/revoke", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    revokeInvite(db, Number(c.form.id));
    redirect(res, "/admin?r=revoked");
  });

  app.post("/admin/role", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = setRole(db, Number(c.form.personId), String(c.form.role), c.form.on === "1");
    redirect(res, `/admin?r=${r.ok ? "saved" : r.reason}`);
  });

  app.post("/admin/capability", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = setCapability(db, Number(c.form.personId), String(c.form.key), c.form.on === "1");
    redirect(res, `/admin?r=${r.ok ? "saved" : r.reason}`);
  });

  app.post("/admin/status", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = setPersonStatus(db, Number(c.form.personId), String(c.form.status));
    redirect(res, `/admin?r=${r.ok ? "saved" : r.reason}`);
  });

  // ---- own profile and operational status (increment O) -------------------------------------------------
  app.get("/me", ({ req, res, query }) => {
    const c = gate({ req, res });
    if (!c) return;
    const sid = seasonId();
    const me = myProfile(db, c.personId, sid);
    if (!me) return send(res, 404, renderErrorPage(t, 404));
    send(res, 200, renderProfile({
      t, session: c.session, roles: c.roles, who: c.who, me,
      score: sid ? score(db, c.personId, sid) : 0,
      flash: profileFlash(t, query.get("r")),
      calendar: {
        exists: hasCalendarToken(db, c.personId),
        // Shown ONCE, immediately after creation, exactly like an invite token: only its hash is stored, so
        // there is nothing to show later. Held in memory keyed by person, not in the URL — a capability URL in
        // a query string ends up in logs and browser history.
        fresh: freshCalendarLinks.get(c.personId) ?? null,
        // The feed puts events at a real instant, which needs a real time zone. If nobody set one the app
        // falls back to UTC and SAYS so, rather than quietly placing every shift an hour or two out.
        timezoneConfigured: calendarConfig(cfg).configured,
      },
    }));
    freshCalendarLinks.delete(c.personId);
  });

  // The feed itself. No session: a calendar client cannot present one, so the token in the path IS the
  // credential. Read-only, and it must never set a cookie or reveal whether a token merely exists.
  app.get("/calendar/:token.ics", ({ req, res, params }) => {
    const key = clientKey(req);
    if (limiter.blocked(key)) return send(res, 429, "", { "Retry-After": "600", "Content-Type": "text/plain" });
    const who = personByCalendarToken(db, params.token);
    if (!who) {
      // A wrong token is a failed authentication, so it counts toward the same limiter that guards sign-in —
      // this endpoint is the one an attacker can hammer without an account. 404, not 403: "that token is
      // wrong" and "there is no such feed" must be indistinguishable.
      limiter.fail(key, "calendar-token");
      return send(res, 404, "", { "Content-Type": "text/plain" });
    }
    const cal = calendarConfig(cfg);
    // A little history, so a feed is not empty in the first week of a season.
    const from = new Date(Date.parse(`${today()}T00:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10);
    const body = buildIcs({
      rows: calendarRowsFor(db, who.personId, from),
      calendarName: t("calendar.name", { app: t("app.title") }),
      timeZone: cal.timezone,
      eventMinutes: cal.eventMinutes,
      t,
    });
    send(res, 200, body, {
      "Content-Type": "text/calendar; charset=utf-8",
      // Not attachment: a subscribing client fetches this repeatedly and must not be offered a download.
      "Content-Disposition": 'inline; filename="4water.ics"',
      "Cache-Control": "private, max-age=300",
    });
  });

  app.post("/me/calendar", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    if (c.form.action === "revoke") {
      revokeCalendarToken(db, c.personId);
      freshCalendarLinks.delete(c.personId);
      return redirect(res, "/me?r=calendar_revoked");
    }
    // Rotate on every create: asking for a link when one exists means the old one is lost or leaked, and
    // handing back the same secret would make "regenerate" a lie.
    const made = calendarTokenFor(db, c.personId, { rotate: true });
    if (made?.token) {
      // Absolute when the deployment says what it is called: a calendar client cannot resolve a relative path.
      // Without FOURWATER_BASE_URL the path is still correct and the page says to prefix the site address —
      // guessing an origin from the Host header would let a proxied request mint a link pointing anywhere.
      const base = String(env.FOURWATER_BASE_URL || "").replace(/\/+$/, "");
      freshCalendarLinks.set(c.personId, `${base}/calendar/${made.token}.ics`);
    }
    redirect(res, "/me?r=calendar_created");
  });

  app.post("/me", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    // The person edited is the SESSION's person. There is no id in this form for the same reason the
    // availability form has none.
    const r = saveProfile(db, c.personId, c.form);
    redirect(res, `/me?r=${r.ok ? "saved" : r.reason}`);
  });

  app.get("/status", async ({ req, res }) => {
    const c = gate({ req, res }, "planner");
    if (!c) return;
    // Read the cached discovery result so the page can say whether sign-in found the IdP's own metadata or is
    // running on the NextCloud-shaped fallback. Cached, so this does not make loading /status hit the network
    // on every view — and a failure here must not take the status page down with it.
    let oidcState = null;
    if (oidc.enabled) {
      try { oidcState = { enabled: true, ...(await discoverOidc(oidc)) }; }
      catch (e) { oidcState = { enabled: true, source: "fallback", error: e.message }; }
    }
    // `channel` only — never the webhook, whose path is the credential. The page needs to know whether one is
    // configured so it does not tell an operator "no webhook is configured" while one plainly is.
    const status = collectStatus(db, {
      pattern: cfg, today: today(), backupDir: backupConfig(env).dir, oidc: oidcState,
      notify: { channel: notifyConfig(env).channel },
    });
    send(res, 200, renderStatus({ t, session: c.session, roles: c.roles, who: c.who, status }));
  });

  // The outbox. Without this, every message the app composes with no webhook configured — which is the default
  // — went into a table nobody could read, and /status could only report the count.
  app.get("/outbox", ({ req, res, query }) => {
    const c = gate({ req, res }, "planner");
    if (!c) return;
    const wanted = query.get("status");
    const status = ["queued", "failed", "sent"].includes(wanted) ? wanted : null;
    const outbox = listOutbox(db, { status });
    // Derived from `channel`, never from `webhook`. The webhook URL IS the credential — its path is the
    // secret — so it must not travel into a render function at all, not even to be tested for truthiness.
    send(res, 200, renderOutbox({
      t, roles: c.roles, who: c.who, outbox,
      webhookConfigured: notifyConfig(env).channel !== "outbox",
    }));
  });

  // ---- erasure, export, retention (increment N) ---------------------------------------------------------
  app.post("/admin/erase", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = erasePerson(db, Number(c.form.personId), { mode: String(c.form.mode ?? "") });
    if (!r.ok) return redirect(res, `/admin?r=${r.reason === "bad_mode" ? "erase_bad_mode" : r.reason}`);
    redirect(res, `/admin?r=erased&who=${encodeURIComponent(r.was)}&mode=${r.mode}`);
  });

  // One person's data as JSON, for an access or portability request. Admin-only here; a volunteer downloads
  // their OWN copy from their profile, which is the same function with the session's id.
  app.get("/admin/person/:id/export.json", ({ req, res, params }) => {
    const c = gate({ req, res }, "admin");
    if (!c) return;
    sendPersonExport(res, Number(params.id));
  });

  app.get("/me/export.json", ({ req, res }) => {
    const c = gate({ req, res });
    if (!c) return;
    sendPersonExport(res, c.personId);
  });

  function sendPersonExport(res, personId) {
    const data = exportPerson(db, personId);
    if (!data) return send(res, 404, renderErrorPage(t, 404));
    data.exportedAt = new Date().toISOString();
    send(res, 200, JSON.stringify(data, null, 2), {
      "Content-Type": "application/json; charset=utf-8",
      // A download rather than a page: this is a file somebody hands to a person who asked for their data.
      "Content-Disposition": `attachment; filename="4water-person-${personId}.json"`,
    });
  }

  app.get("/planner/season.csv", ({ req, res }) => {
    const c = gate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    if (!sid) return send(res, 404, renderErrorPage(t, 404));
    send(res, 200, exportSeasonCsv(db, sid), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="4water-${cfg.season.key}.csv"`,
    });
  });

  app.post("/admin/retention", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = runRetention(db, { pattern: cfg, currentKey: cfg.season.key });
    redirect(res, `/admin?r=retention_done&notifications=${r.notifications.removed}&seasons=${r.seasons.removed.length}`);
  });

  // Every config edit goes through validate-then-atomic-write, then reloads in this process.
  const applyPattern = (next, res, { fromDate = null, okCode = "saved" } = {}) => {
    // seedSeason, not seedStructure: adding a timeslot used to create the sessions and none of their slots, so
    // a newly added class appeared on the plan and could never be staffed.
    const r = savePattern(db, next, { file: patternFile, seed: (d, p) => seedSeason(d, p, { fromDate }) });
    if (!r.ok) return redirect(res, `/admin?r=invalid&m=${encodeURIComponent(r.message)}`);
    reloadPattern(r.pattern);
    redirect(res, `/admin?r=${okCode}&n=${r.seeded?.sessions ?? 0}`);
  };

  app.post("/admin/season", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    applyPattern(patternFromForm(cfg, c.form), res);
  });

  app.post("/admin/activity", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    applyPattern(addActivityToForm(cfg, c.form), res);
  });

  // ---- the weekly rhythm (increment Q) ------------------------------------------------------------------
  app.post("/admin/weekly/add", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const [hour, minute] = String(c.form.time ?? "").split(":");
    // __all, because the activity checkboxes share one name and Object.fromEntries keeps only the last.
    const next = addWeeklyToForm(cfg, {
      dayOfWeek: c.form.dayOfWeek, hour, minute, activities: c.form.__all("activities"),
    });
    // fromDate = today, so adding a slot in August does not manufacture unfilled sessions back to January.
    applyPattern(next, res, { fromDate: today(), okCode: "weekly_added" });
  });

  app.post("/admin/weekly/remove", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const { pattern: next, removed } = removeWeeklyFromForm(cfg, c.form);
    if (removed === 0) return redirect(res, "/admin?r=weekly_not_found");
    applyPattern(next, res, { okCode: "weekly_removed" });
  });

  // How many OTHER people could take this slot — the number is what makes the message actionable rather
  // than noise. Uses the same eligibility definition as the board.
  async function announceOpenSlot(assignmentId, detail) {
    if (!notifier) return;
    const eligible = db.prepare(`
      SELECT COUNT(*) n FROM people p
       WHERE EXISTS (SELECT 1 FROM assignments a
                      JOIN sessions s ON s.id = a.session_id
                      JOIN timeslots ts ON ts.id = s.timeslot_id
                      JOIN capabilities c ON c.person_id = p.id AND c.activity_id = s.activity_id
                     WHERE a.id = :aid AND a.person_id IS NULL
                       AND COALESCE(
                             (SELECT ah.available FROM availability_hour ah
                               WHERE ah.person_id = p.id AND ah.date = s.date AND ah.hour = ts.hour),
                             (SELECT ad.available FROM availability_day ad
                               WHERE ad.person_id = p.id AND ad.date = s.date), 0) = 1)`).get({ aid: assignmentId }).n;
    await notifier.send({
      kind: "slot_open",
      body: slotOpenMessage(t, {
        when: `${formatDate(t, detail.date)} ${formatTime(detail.hour, detail.minute)}`,
        // WITH the role. Increment U put "Salsa · leader" on the board, the plan and the planner and left the
        // announcement saying only "Salsa" — so the one place the message has to stand alone, in a chat channel
        // away from the app, was the one place a volunteer could not tell whether it was theirs to take.
        // formatRole returns "" for a slot with no role, so a workshop reads exactly as it did before.
        activity: `${detail.label}${formatRole(t, detail.role)}`,
        eligible,
      }),
    });
  }

  return app;
}

// Entry point. Use pathToFileURL rather than building the URL by hand: on Windows an absolute path becomes
// file:///C:/... with THREE slashes, so `file://${path}` never matches and `node src/server.mjs` exits 0
// having done nothing — no error, no output. Caught by running it, not by any unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  migrate(db);

  // Materialise the season from config. This was MISSING and the app booted completely inert — no season, no
  // activities, no sessions, every page an empty state — because every test builds its world through
  // tools/testkit.mjs, which seeds explicitly. The harness was doing what production did not.
  // seedStructure is idempotent, so running it on every boot is safe and keeps a config edit from needing a
  // separate migration step.
  const configFile = patternFileFor();
  if (configFile !== PATTERN_FILE) console.log(`config: ${configFile}`);
  const boot = loadPattern(configFile);
  const { sessions, slots } = seedSeason(db, boot);
  if (sessions > 0 || slots > 0) {
    console.log(`seeded ${sessions} new session(s) and ${slots} open slot(s) for season ${boot.season.key}`);
  }
  // A season with sessions and no slots is the shape of the bug this replaced: every screen renders, and there
  // is nothing to claim, assign or propose. Cheap to check, and it must never be true again.
  const naked = db.prepare(`SELECT COUNT(*) n FROM sessions s
                             WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.session_id = s.id)`).get().n;
  if (naked > 0) console.warn(`⚠ ${naked} session(s) have no slots — the plan will look populated and be unusable.`);

  // Say so loudly if nobody can get in yet, rather than serving a working-looking app that refuses everyone.
  const admins = db.prepare(`SELECT COUNT(*) n FROM person_roles pr JOIN roles r ON r.id = pr.role_id
                              WHERE r.name = 'admin'`).get().n;
  if (admins === 0) {
    console.warn(`\n⚠ There is no administrator yet, so nobody can sign in or invite anyone.`);
    console.warn(`  Create the first one:  node tools/bootstrap.mjs <email> "<name>"\n`);
  }
  // The notifier and the nudge timer, WIRED HERE, because nothing else does it.
  //
  // Until this existed, makeNotifier and startJobs were called only from tests. buildApp defaults notifier to
  // null and announceOpenSlot opens with `if (!notifier) return`, so on a real deployment no "a shift became
  // free" announcement ever fired and the availability nudge never ran once — while seventeen tests proved the
  // machinery worked, because the test harness passed a notifier that production did not. Same generator as the
  // missing slots: the harness doing setup the real boot path skipped.
  //
  // With no MATTERMOST_WEBHOOK the channel is the outbox, which is not a degraded mode — messages are written
  // and a planner reads them at /outbox. That is the default and it is fine; silence was the bug.
  const notifyCfg = notifyConfig(process.env);
  const notifier = makeNotifier({ db, config: notifyCfg });
  const bootT = makeT(boot.locale ?? "en");
  const currentSeasonId = () => db.prepare("SELECT id FROM seasons WHERE key = ?").get(boot.season.key)?.id ?? null;
  const jobs = startJobs({ db, notifier, t: bootT, seasonId: currentSeasonId, today: () => new Date().toISOString().slice(0, 10) });
  console.log(`notifications: ${notifyCfg.describe()}`);   // describe() never reveals the URL — its path is the secret

  const port = Number(process.env.PORT) || 8080;
  const server = buildApp({ db, pattern: boot, patternFile: configFile, notifier })
    .listen(port, process.env.HOST || "127.0.0.1");
  console.log(`4water listening on http://127.0.0.1:${port}`);

  // Run the nudge check once shortly after boot as well as on the interval. Six hours is a long time to wait to
  // find out the job is misconfigured, and runNudge is idempotent per (kind, person, period) so an extra call
  // cannot produce an extra message.
  setTimeout(() => { jobs.tick().catch(() => {}); }, 5_000).unref?.();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => { jobs.stop(); server.close(); db.close(); process.exit(0); });
  }
}
