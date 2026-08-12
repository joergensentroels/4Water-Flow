// Wiring. Routes live here; the work lives in src/pages/*. Exported as buildApp() so tests can run the real
// server on an ephemeral port rather than a mock â€” the bugs worth catching are in the plumbing.
import { pathToFileURL } from "node:url";
import { createApp, send, redirect, readForm, html } from "./http.mjs";
import { loadPattern, makeT, PATTERN_FILE, patternFileFor, calendarConfig, exportConfig,
         notifyTimingConfig, publicBaseUrl } from "./config.mjs";
import { openDb, migrate } from "./db.mjs";
import { readSession, sign, cookieHeader, clearCookieHeader, newCsrf, checkCsrf, sessionSecret } from "./session.mjs";
import { rolesOf, requireRole, devSignIn, assertDevAllowed, oidcConfig, beginOidc, discoverOidc, checkState, completeOidc,
         linkIdentity, redeemInvite, inviteStatus, createInvite, revokeInvite } from "./auth.mjs";
import { layout, navFor, formatDate, formatTime, formatRole, renderErrorPage, renderPrivacy, renderInvite } from "./views.mjs";
import { slotOpenMessage, notifyConfig, makeNotifier } from "./notify.mjs";
import { startJobs } from "./jobs.mjs";
import { datesNeedingAnswer, currentAnswers, renderAvailability, saveAvailability, bulkTargets, answerProgress } from "./pages/availability.mjs";
import { renderHome, renderPlan } from "./pages/plan.mjs";
import { renderBoard, flashFor } from "./pages/board.mjs";
import { renderPlanner, plannerFlash } from "./pages/planner.mjs";
import { autoRoster, lockInProposals, discardProposals, countProposals, rosterReview } from "./roster.mjs";
import { renderAdmin, adminFlash } from "./pages/admin.mjs";
import { peopleWithDetail, PEOPLE_PAGE, invitesWithDetail, setRole, setCapability, setPersonStatus,
         savePattern, patternFromForm, addActivityToForm, proposeNextSeason,
         addWeeklyToForm, removeWeeklyFromForm, sessionsForSlot,
         setClassesAnyway, sessionsOnDate } from "./admin.mjs";
import { seedSeason } from "./seed.mjs";
import { makeLimiter, clientKey } from "./ratelimit.mjs";
import { recordAudit, listAudit, countAudit, describeAudit, hasOlderAudit } from "./audit.mjs";
import { erasePerson, exportPerson, exportSeasonCsv, runRetention, retentionConfig } from "./retention.mjs";
import { renderAudit } from "./pages/audit.mjs";
import { renderSession, sessionFlash } from "./pages/session.mjs";
import { listNotes, addNote, deleteNote, noteCounts } from "./notes.mjs";
import { holidayConfig, holidaysBetween, suppressed } from "./holidays.mjs";
import { myProfile, saveProfile, renderProfile, profileFlash } from "./pages/profile.mjs";
import { collectStatus, renderStatus } from "./pages/status.mjs";
import { listOutbox, renderOutbox } from "./pages/outbox.mjs";
import { backupConfig } from "../tools/backup.mjs";
import { myUpcoming, planForSeason, horizonWeeks, withinHorizon, score, openSlotsFor, claimSlot, handBackSlot,
         eligiblePeopleFor, assignSlot, unassignSlot, calendarRowsFor, boardEmptyReason, slotEmptyReason,
         attendedCount, markAttendance, unmarkedShifts,
         sessionDetail, peopleOnSession } from "./queries.mjs";
import { buildIcs, calendarTokenFor, revokeCalendarToken, hasCalendarToken,
         personByCalendarToken } from "./calendar.mjs";

// `today` is a single injected clock for the whole app: "upcoming" here, the hand-back cutoff in the board,
// and the nudge window later all need one, and three separate calls to new Date() is how those drift apart
// in tests. Returns an ISO date string because everything stored is a date, not an instant.
// `patternFile` is injectable so a test never rewrites the repository's own config. Without it, running the
// admin suite would silently edit config/pattern.json â€” a test that damages the thing it is testing.
// `onPatternChange` exists because the config is mutable HERE and was frozen everywhere else. See reloadPattern.
export function buildApp({ db, pattern = loadPattern(), env = process.env, notifier = null,
                           patternFile = PATTERN_FILE, jobs = null, onPatternChange = null,
                           today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const secret = sessionSecret(env);
  // Validated HERE, once, not where it is used. A malformed FOURWATER_BASE_URL did already fail the standard boot,
  // but only because notifyConfig() happens to run on the way up — which made the RUNBOOK's "refused at startup"
  // true by call order rather than by construction. Anything building the app without a notifier would have
  // deferred the throw to whichever request first needed a link, turning a startup refusal into a 500 on the
  // invite route. The result is discarded: this line exists to fail, and the callers below ask again.
  publicBaseUrl(env);
  const secure = env.NODE_ENV === "production";
  const oidc = oidcConfig(env);
  const devAuth = env.FOURWATER_AUTH === "dev" && env.NODE_ENV !== "production";

  // Deliberately mutable: the admin screen edits config/pattern.json, and the running process must pick that
  // up immediately. Telling an admin to restart the server would be the same class of failure as a cached
  // credential that only looks rotated â€” the file says one thing while the process believes another.
  let cfg = pattern;
  let t = makeT(cfg.locale);
  // ...and ANNOUNCED, because "the running process must pick that up immediately" was true of the routes and
  // false of the nudge timer. The boot block built the jobs' season getter as a closure over the pattern it
  // loaded at startup, so `cfg` moved here and that getter did not.
  //
  // Measured through the real admin route: rolling over from 2026-Q1Q2 to 2026-Q3Q4 seeded 106 sessions into the
  // new season, the pages followed it, and the jobs' getter still returned the OLD season's id. Both notification
  // features then operate on a season that is entirely in the past, so `volunteersNeedingNudge` finds no dates in
  // its window and `shiftsNeedingReminder` finds no shifts â€” nobody is nudged and nobody is reminded, until
  // somebody restarts the process. `/status` reports a recent run having sent 0, which is precisely what a
  // healthy quiet instance looks like: jobs.mjs warns in its own comments that a dead nudge and an unneeded one
  // are indistinguishable from outside, and this is how that happens.
  //
  // Season rollover is the one operation this app was explicitly built to support, so the failure is not exotic.
  const reloadPattern = (next) => { cfg = next; t = makeT(cfg.locale); onPatternChange?.(next); };
  const seasonId = () => db.prepare("SELECT id FROM seasons WHERE key = ?").get(cfg.season.key)?.id ?? null;

  // Throttle for the routes reachable without a session â€” the OIDC callback, invite redemption and the calendar
  // feed. An alarm, not a lock; see ratelimit.mjs. The list is enumerated and enforced in test/csrf-audit.test.mjs
  // rather than counted here, because this sentence said "two" for an entire increment after the third arrived.
  const limiter = makeLimiter();
  setInterval(() => limiter.sweep(), 60_000).unref?.();

  // Error pages need the layout and the current locale, both of which live here rather than in the router.
  // The request is passed through so an error page can carry the viewer's own nav. It may be absent (the 400 for
  // an undecodable path fires before anything is read), and then roles stays null and no nav is drawn.
  const app = createApp({
    renderError: (status, req) => {
      const c = req ? ctx(req) : null;
      return renderErrorPage(t, status, { signedIn: !!c?.session?.personId, roles: c?.session?.personId ? c.roles : null });
    },
  });

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
  // WHERE TO GO AFTER SIGNING IN, and the only thing that decides whether a destination is allowed.
  //
  // Increment AI put a link in every notification, which created a journey nobody had walked: a volunteer taps
  // "Open the shift exchange: https://…/board" in Mattermost, on a phone with no session, and the 401 below sent
  // them to a bare /signin. Measured end to end — 303 to /signin, sign in, 303 to `/`. **They tapped a link to the
  // shift exchange and arrived at the home page**, with nothing on either screen remembering where they had been
  // going. Every part worked; the composition dropped them one step short of the thing they came for, which is the
  // chasing the link exists to remove.
  //
  // An open redirect is the obvious hazard in fixing this, and it is a real one here: this app already refuses to
  // build an origin from the `Host` header because a forged one would render a link to somebody else's server. So
  // this is an ALLOWLIST, not a filter. A destination is acceptable only if the router would actually serve a GET
  // for it — `//evil.com`, `https://evil.com`, `/board/../admin`, a percent-encoded authority and every spelling
  // nobody has thought of are refused by not being routes, rather than by being recognised as attacks. A filter has
  // to anticipate; this asks the router, which already knows.
  //
  // The auth routes are excluded because they are the only ones that would loop: /signin?next=/signin, or a
  // /auth/oidc that starts a second round trip with the first one's state in the cookie. Derived from the path
  // rather than listed, so a new /auth/* route is covered the day it is added.
  const NEXT_LOOPS = /^\/(signin|signout|auth\/|invite\/)/;
  const safeNext = (raw) => {
    const value = String(raw ?? "");
    if (!value || value.length > 200) return null;
    // Belt and braces: neither of these could match a route anyway, but a destination that is not a plain
    // same-origin path should be refused by something that says so, not only by failing to be found.
    if (!value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) return null;
    const pathname = value.split("?")[0].split("#")[0];   // query dropped: nothing needs it, and it widens this
    if (NEXT_LOOPS.test(pathname)) return null;
    return app.canServe("GET", pathname) ? pathname : null;
  };
  // One place decides where a successful sign-in lands, so the three sign-in paths cannot drift apart.
  const landing = (raw) => safeNext(raw) ?? "/";

  const gate = ({ req, res }, role = null) => {
    const { session, roles } = ctx(req);
    const g = requireRole(db, session, role);
    if (!g.ok) {
      // The path they were actually trying to reach, carried through sign-in. Only for 401 — a 403 means they are
      // signed in and not allowed, and sending them back to a page they may not have is not help.
      if (g.status === 401) {
        // Not for "/" — that is where sign-in lands anyway, so ?next=%2F would be a parameter that says nothing.
        // The redirect URL should carry a destination only when there is a destination worth carrying.
        const want = safeNext(req.url);
        redirect(res, want && want !== "/" ? `/signin?next=${encodeURIComponent(want)}` : "/signin");
        return null;
      }
      send(res, 403, renderErrorPage(t, 403));
      return null;
    }
    return { session, roles, personId: g.personId, who: db.prepare("SELECT name FROM people WHERE id=?").get(g.personId)?.name ?? "" };
  };

  // One line per audited action. The actor is assembled once here rather than at eighteen call sites, so it
  // cannot be right in seventeen of them — `c` already carries the person id and the name the gate resolved.
  //
  // Called AFTER the action, and it records the outcome rather than only the successes: "a planner tried to
  // unassign somebody and was refused because the row had changed" is exactly the sort of thing somebody asks
  // about later. `detail` must never carry a secret; see the note on recordAudit.
  const logAudit = (c, action, subject = null, detail = null) =>
    recordAudit(db, { actorId: c.personId, actorName: c.who, action, subject, detail });

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
    const next = safeNext(query.get("next"));
    // Already signed in and asked for a page: send them there rather than home. This is the case where somebody
    // taps a notification link on a phone that DOES have a session but followed a stale /signin link.
    if (session?.personId) return redirect(res, next ?? "/");
    const people = devAuth ? db.prepare("SELECT id, name FROM people ORDER BY name LIMIT 25").all() : [];
    // Carried as a query parameter on the OIDC link and a hidden field on the dev form. Re-validated at both
    // receiving ends: this value has been through the client, so arriving here safe says nothing about arriving
    // back safe. `next` is only ever a path that app.canServe agreed to, so interpolating it is not a redirect
    // vector — and it is escaped like everything else because html`` escapes unconditionally.
    const body = html`
      <h2>${t("signin.title")}</h2>
      ${query.get("unknown") ? html`<p class="flash bad">${t("signin.unknown")}</p>` : ""}
      ${oidc.enabled ? html`<p><a class="btn" href="${next ? `/auth/oidc?next=${encodeURIComponent(next)}` : "/auth/oidc"}">${t("signin.nextcloud")}</a></p>` : ""}
      <p class="hint">${t("signin.invite")}</p>
      ${devAuth ? html`
        <div class="card">
          <h2>${t("signin.dev")}</h2>
          <form method="post" action="/auth/dev">
            ${next ? html`<input type="hidden" name="next" value="${next}">` : ""}
            ${people.map((p) => html`<p><button type="submit" name="personId" value="${p.id}" class="secondary">${p.name}</button></p>`)}
          </form>
        </div>` : ""}`;
    send(res, 200, layout({ t, title: t("signin.title"), body }));
  });

  // The dev sign-in has no CSRF token because there is no session yet. It is gated by assertDevAllowed(),
  // which throws under NODE_ENV=production â€” the route simply does not function in a real deployment.
  // REGISTERED ONLY WHEN ALLOWED, so in production the route does not exist and the router answers 404.
  // It used to be registered unconditionally and rely on assertDevAllowed throwing, which refused correctly â€”
  // no session was issued â€” but answered 500. That is the wrong answer three ways: it reads as "the server
  // broke" rather than "there is no such thing here", it files an error in the log for what is actually the
  // safety posture working, and it tells anyone probing that the route exists and blew up. The assert stays
  // inside as well, so that making registration unconditional again cannot quietly re-open it.
  if (devAuth) app.post("/auth/dev", async ({ req, res }) => {
    assertDevAllowed(env);
    const form = await readForm(req);
    const who = devSignIn(db, form.personId, env);
    if (!who) return redirect(res, "/signin?unknown=1");
    // Re-validated, not trusted: the hidden field has been through the client.
    redirect(res, landing(form.next), { "Set-Cookie": setSession({ personId: who.personId }) });
  });

  // async because the authorization endpoint now comes from the IdP's discovery document rather than a
  // hardcoded NextCloud path. The document is cached, so this is one request per issuer per 10 minutes.
  app.get("/auth/oidc", async ({ res, query }) => {
    const { url, state, verifier } = await beginOidc(oidc);
    // state and verifier ride in the session cookie: no server-side store, and they are signed, so a
    // callback cannot be replayed with attacker-chosen values.
    //
    // The destination rides in the SAME signed cookie, for the same reason and not as a query parameter on the
    // callback URL. The provider echoes back only what OIDC defines; anything this app appended to its own
    // redirect_uri would have to be accepted from the callback query, which is attacker-controlled. The cookie is
    // signed, so a tampered destination fails the signature and the whole sign-in is refused rather than redirected.
    const oidcNext = safeNext(query.get("next"));
    redirect(res, url, { "Set-Cookie": cookieHeader(sign({ oidcState: state, oidcVerifier: verifier, oidcNext, csrf: newCsrf() }, secret), { secure, maxAge: 600 }) });
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
    // emailVerified is forwarded, not dropped. linkIdentity refuses to adopt a pre-registered record on an
    // address the provider marks unverified, and a guard that exists but is never reached is the defect this
    // project keeps finding â€” twice a whole feature was dead in production with a green suite over it.
    const person = linkIdentity(db, "oidc", id.subject,
                                { name: id.name, email: id.email, emailVerified: id.emailVerified });
    if (!person) return redirect(res, "/signin?unknown=1", { "Set-Cookie": clearCookieHeader({ secure }) });
    // From the signed cookie, and validated again anyway. The signature already proves this app wrote it, so the
    // second check is belt and braces — but the route table can change between the two requests, and a destination
    // that has stopped being servable should land on the home page rather than 404 at the end of a sign-in.
    redirect(res, landing(session.oidcNext), { "Set-Cookie": setSession({ personId: person.personId }) });
  });

  // This GET asks; it does not accept. It used to redeem the invitation, and the link arrives BY EMAIL â€” mail
  // security gateways fetch links to scan them before the recipient ever sees them. Measured, not theorised: one
  // anonymous GET created the person, marked the invitation spent, and handed the session cookie to the fetcher.
  // The volunteer's own click then got /signin?unknown=1, and re-inviting did not help, because the next link
  // went down the same pipe. A volunteer who cannot get in is the one failure this whole app cannot absorb.
  //
  // Accepting is a POST below, which no scanner, prefetcher or link unfurler issues.
  app.get("/invite/:token", ({ req, res, params }) => {
    const key = clientKey(req);
    if (limiter.blocked(key)) return send(res, 429, renderErrorPage(t, 429), { "Retry-After": "600" });
    const s = inviteStatus(db, params.token);
    if (!s.ok) {
      limiter.fail(key, "invite");
      return redirect(res, "/signin?unknown=1");
    }
    // Deliberately NOT limiter.succeed(): nothing has been proven yet, and a scanner walking a bad token then a
    // good one should not have its failure forgiven by a page view.
    send(res, 200, renderInvite({ t, token: params.token, email: s.email }));
  });

  // No CSRF token, for the same reason /auth/dev has none: there is no session yet to carry one. Possession of
  // the invitation token IS the authorization here â€” anyone who could forge this POST could simply follow the
  // link themselves. test/csrf-audit.test.mjs names both as decisions rather than omissions.
  app.post("/invite/:token/accept", async ({ req, res, params }) => {
    const key = clientKey(req);
    if (limiter.blocked(key)) return send(res, 429, renderErrorPage(t, 429), { "Retry-After": "600" });
    await readForm(req);   // drain the body; nothing in it is used
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
      rows: sid ? datesNeedingAnswer(db, sid, today()) : [],
      answers: currentAnswers(db, c.personId),
      progress: sid ? answerProgress(db, c.personId, sid, today()) : null,
      flash: query.get("saved") ? { text: t("availability.saved") }
            : query.get("bulk") ? { text: t("availability.bulkDone", { n: query.get("bulk") }) } : null,
    }));
  });

  app.post("/availability", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const sid = seasonId();
    if (sid) saveAvailability(db, c.personId, c.form, sid, today());
    redirect(res, "/availability?saved=1");
  });

  // Bulk answer. Builds the same field names the per-date form posts and hands them to the SAME writer, so
  // there is one place that validates a date and one place that writes â€” a second writer here would be
  // where the "fabricated date" guard quietly stopped applying.
  app.post("/availability/bulk", async ({ req, res }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const sid = seasonId();
    if (!sid) return redirect(res, "/availability");
    // The same cutoff as the form, or a bulk action would answer for dates the form no longer shows.
    const rows = datesNeedingAnswer(db, sid, today());
    const { rows: targets, value } = bulkTargets(rows, { scope: String(c.form.scope ?? ""), value: String(c.form.value ?? "") });
    if (targets.length === 0) return redirect(res, "/availability");
    const synthetic = Object.fromEntries(targets.map((r) => [`slot:${r.date}:${r.hour}`, value]));
    saveAvailability(db, c.personId, synthetic, sid, today());
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
      // Same helper the availability form's own counter uses, so the two screens cannot disagree about how far
      // along somebody is.
      progress: sid ? answerProgress(db, c.personId, sid, today()) : null,
      // Not derivable from the score: a stood-down volunteer keeps the shifts they already did, so the score
      // stays positive while the roster no longer holds them. See renderHome.
      status: db.prepare("SELECT status FROM people WHERE id = ?").get(c.personId)?.status ?? "active",
    }));
  });

  app.get("/plan", ({ req, res, query }) => {
    const c = gate({ req, res });
    if (!c) return;
    const sid = seasonId();
    // The same four-week horizon the planner's grid has had all along, and for a stronger reason: measured at 375px on
    // the demo, this page was 15,012 pixels tall and opened six weeks in the past, so the first thing a volunteer saw
    // was late June and the answer to "am I on this week" was eighteen screens down. `weeks=all` includes the past here,
    // because looking back is a legitimate thing to want from a read-only plan — see withinHorizon.
    const weeks = horizonWeeks(query.get("weeks"));
    const all = sid ? planForSeason(db, sid) : [];
    let rows = withinHorizon(all, { today: today(), weeks, past: weeks === null });
    // IF THE WINDOW IS EMPTY AND THE SEASON IS NOT, show the season and say so. The horizon is an ergonomic default,
    // not a filter anybody asked for, and the first version of it broke the shipped configuration: 4water's real export
    // covers January to June, so on any date after that the next four weeks are empty and this page said "There are no
    // activities in this season yet" about a season with 223 of them. test/firstrun.test.mjs caught it by booting a real
    // deployment — the assertion is literally that a bootstrapped install must not look empty.
    //
    // Widening automatically is what a person would do; the hint is what stops the chips lying about which view is on
    // screen, which is the mistake the planner's own horizon made once already.
    // Expressed through the chips rather than a sentence: when it widens, the effective horizon IS "the whole
    // season", so that chip carries aria-current and the page describes its own state without a new claim. The first
    // version added a string saying "nothing in the next four weeks, so the whole season is shown" — accurate, and
    // test/claims.test.mjs refused it: causal strings must each be justified, and the list is capped at twenty on the
    // grounds that a longer one gets rubber-stamped. A cap that forces a better answer rather than a longer list is
    // doing its job, and the better answer was to let the control tell the truth.
    let effectiveWeeks = weeks;
    if (rows.length === 0 && all.length > 0) { rows = all; effectiveWeeks = null; }
    send(res, 200, renderPlan({
      t, roles: c.roles, who: c.who, personId: c.personId, rows, weeks: effectiveWeeks,
      // ONE query for every session on the page. The per-row alternative is the N+1 this project has fixed twice,
      // and this page renders the whole season — 173 sessions in the measured fixture.
      notes: noteCounts(db, [...new Set(rows.map((r) => r.sessionId))]),
    }));
  });

  // ---- one session, and the notes on it -----------------------------------------------------------------
  //
  // Every signed-in person may read and write here. That is a decision about a volunteer organisation of forty
  // people who already share a chat channel, not an oversight: a note says "bring the speaker", and hiding it from
  // whoever might take the shift would defeat the point. What is NOT possible is touching somebody else's words.
  app.get("/session/:id", ({ req, res, params, query }) => {
    const c = gate({ req, res });
    if (!c) return;
    const detail = sessionDetail(db, Number(params.id));
    if (!detail) return send(res, 404, renderErrorPage(t, 404));
    send(res, 200, renderSession({
      t, session: c.session, roles: c.roles, who: c.who, me: c.personId, detail,
      people: peopleOnSession(db, detail.id),
      notes: listNotes(db, detail.id),
      flash: sessionFlash(t, query.get("r")),
    }));
  });

  app.post("/session/:id/note", async ({ req, res, params }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const id = Number(params.id);
    const r = addNote(db, id, { personId: c.personId, authorName: c.who, body: c.form.body });
    if (!r.ok && r.reason === "no_such_session") return send(res, 404, renderErrorPage(t, 404));
    redirect(res, `/session/${id}?r=${r.ok ? "note_added" : r.reason}`);
  });

  // Deleting your OWN note. Which note comes from the URL; WHOSE it is comes from the session and never from the
  // form — the same rule as the profile page, where a person field in a form is a person field an attacker fills in.
  app.post("/note/:id/delete", async ({ req, res, params }) => {
    const c = await postGate({ req, res });
    if (!c) return;
    const note = db.prepare("SELECT session_id AS sessionId FROM notes WHERE id=?").get(Number(params.id));
    if (!note) return send(res, 404, renderErrorPage(t, 404));
    const r = deleteNote(db, Number(params.id), c.personId);
    redirect(res, `/session/${note.sessionId}?r=${r.ok ? "note_deleted" : r.reason}`);
  });

  // ---- the vagtbÃ¸rs (increment D) ----------------------------------------------------------------------
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
    logAudit(c, "board.claim", `assignment:${params.id}`, r.ok ? "took an open shift" : `refused: ${r.reason}`);
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
    logAudit(c, "board.handBack", `assignment:${id}`, r.ok ? "gave a shift back" : `refused: ${r.reason}`);
    const code = r.ok ? (r.pastCutoff ? "handed_back_late" : "handed_back") : r.reason;

    // Announce it, and never let that failure reach the volunteer: the slot IS released, and an error page
    // would make them try again. Deliberately not awaited into the response path.
    // shortNotice so the channel post itself says a planner needs to look, instead of relying on the
    // volunteer relaying it. The banner asks them to as well; this makes that a courtesy.
    if (r.ok && detail) announceOpenSlot(id, detail, { shortNotice: !!r.pastCutoff }).catch(() => {});
    redirect(res, `/board?r=${code}`);
  });

  // ---- planner grid (increment F) -----------------------------------------------------------------------
  app.get("/planner", ({ req, res, query }) => {
    const c = gate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    let rows = sid ? planForSeason(db, sid).filter((r) => r.date >= today()) : [];

    // A HORIZON, defaulting to four weeks. Measured at a realistic size â€” 200 volunteers, six slots a week â€”
    // the whole-season view rendered 490 KB of HTML, because every open slot carries a dropdown of every
    // eligible person. Half a megabyte on a phone on mobile data is not a planner screen. Four weeks is also
    // simply the right amount of work to look at; the links below extend it when needed.
    // withinHorizon rather than the arithmetic inline, so this page and /plan cannot drift. `past` stays false: a
    // grid of shifts that already happened is not work to do.
    const weeks = horizonWeeks(query.get("weeks"));
    rows = withinHorizon(rows, { today: today(), weeks, past: false });

    // "Gaps only" is the view a planner actually wants most of the time: the whole season is noise when the
    // question is "what is still unfilled".
    const gapsOnly = query.get("gaps") === "1";
    if (gapsOnly) rows = rows.filter((r) => r.personId == null);

    // Look up candidates only for the open slots on screen â€” one query per gap, not per row. Gaps are the
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
      // The clock, and the backlog of shifts that have happened and nobody has marked. Both whole-season and
      // independent of the `weeks` horizon, because the grid deliberately shows only the future — a control per
      // grid row could never appear for a past shift, which is how the first attempt at this rendered nothing.
      today: today(),
      unmarked: sid ? unmarkedShifts(db, sid, today()) : [],
      pendingProposals: sid ? countProposals(db, sid, today()) : 0,
      // Whole-season and independent of the `weeks` horizon on purpose: the fairness question is "how much has
      // this person got this season", which a 4-week window cannot answer.
      review: sid ? rosterReview(db, sid) : null,
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
    logAudit(c, "planner.autoRoster", `season:${sid}`, `proposed ${r.filled}, gaps ${r.gaps}`);
    if (r.filled === 0 && r.gaps === 0) return redirect(res, "/planner?r=roster_empty");
    // Which sentence the planner reads is decided HERE, where both numbers are known, rather than by one
    // string trying to cover every case. `n` is whichever count the message inflects on.
    if (r.gaps > 0) return redirect(res, `/planner?r=roster_gaps&filled=${r.filled}&n=${r.gaps}`);
    redirect(res, `/planner?r=roster_done&n=${r.filled}`);
  });

  app.post("/planner/proposals/lock", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    const n = sid ? lockInProposals(db, sid, today()) : 0;
    logAudit(c, "planner.lockProposals", `season:${sid}`, `${n} proposals became the plan`);
    redirect(res, `/planner?r=locked&n=${n}`);
  });

  app.post("/planner/proposals/discard", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const sid = seasonId();
    const n = sid ? discardProposals(db, sid, today()) : 0;
    logAudit(c, "planner.discardProposals", `season:${sid}`, `${n} proposals discarded`);
    redirect(res, `/planner?r=discarded&n=${n}`);
  });

  // Marking who turned up. Score was one number counting shifts HELD, which measures commitment rather than
  // contribution: somebody who takes four and attends one scored the same as somebody who did all four. So there
  // are two numbers now — load, which auto-roster balances, and attendance, which is the record. src/queries.mjs
  // explains why feeding the record to auto-roster would overload whoever holds unstarted shifts.
  //
  // `attended=""` clears it back to "nobody has said", because a mis-click on the wrong row must be undoable
  // without a database edit, and marking the wrong volunteer as a no-show is exactly the mistake worth undoing.
  app.post("/planner/attendance", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const raw = String(c.form.attended ?? "");
    const attended = raw === "" ? null : raw === "1" ? 1 : raw === "0" ? 0 : "bad";
    const id = Number(c.form.assignmentId);
    const r = attended === "bad"
      ? { ok: false, reason: "bad_attendance" }
      : markAttendance(db, id, attended, { today: today() });
    logAudit(c, "planner.attendance", `assignment:${id}`,
             r.ok ? `person:${r.personId} on ${r.date} → ${r.attended === null ? "unmarked" : r.attended ? "attended" : "did not attend"}`
                  : `refused: ${r.reason}`);
    redirect(res, `/planner?weeks=${encodeURIComponent(String(c.form.weeks ?? "4"))}&r=${r.ok ? "attendance_saved" : r.reason}`);
  });

  app.post("/planner/assign", async ({ req, res }) => {
    const c = await postGate({ req, res }, "planner");
    if (!c) return;
    const expect = c.form.expect === "" || c.form.expect == null ? null : Number(c.form.expect);
    const r = assignSlot(db, Number(c.form.assignmentId), Number(c.form.personId), { expectPersonId: expect });
    logAudit(c, "planner.assign", `assignment:${Number(c.form.assignmentId)}`,
             r.ok ? `to person:${Number(c.form.personId)}` : `refused: ${r.reason}`);
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
    logAudit(c, "planner.unassign", `assignment:${id}`,
             r.ok ? `freed ${detail ? detail.date : "?"}` : `refused: ${r.reason}`);
    // A planner freeing a slot puts it on the bÃ¸rs exactly like a volunteer handing it back, so it gets the
    // same announcement â€” otherwise the two paths would behave differently for no reason a volunteer could see.
    if (r.ok && detail) announceOpenSlot(id, detail).catch(() => {});
    redirect(res, `/planner?r=${r.ok ? "unassigned" : r.reason}`);
  });

  // ---- admin (increment H) -------------------------------------------------------------------------------
  // The raw invite token is shown ONCE, right after creation, and never stored â€” only its hash is. So it is
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
      // Public holidays inside THIS season only — a table of every Danish holiday for the next decade is not a
      // decision anybody on this screen has to make. `slots` comes from the database rather than from the config,
      // so a date the planner opted back in shows what is actually on it: the config records the intention and
      // the sessions are the fact, and this screen has to show the fact before offering to delete it.
      holidayCountry: holidayConfig(cfg).country,
      holidays: holidaysBetween(cfg.season.from, cfg.season.to, holidayConfig(cfg)).map((h) => ({
        ...h,
        // Counted for EVERY holiday, not only the opted-in ones. The first version asked the database only when the
        // config said classes run — so a date suppressed by a country added after the season was seeded showed
        // "No sessions on this date" over a plan that still had them. Two true-ish statements, one false screen:
        // the config records an intention and the sessions are the fact, and a screen offering to change the plan
        // has to show the fact.
        slots: seasonId() ? sessionsOnDate(db, seasonId(), h.date).slots : 0,
      })),
      flash: adminFlash(t, query.get("r"), { message: query.get("m") ?? "", who: query.get("who") ?? "",
                                             mode: query.get("mode") ?? "", notifications: query.get("notifications") ?? 0,
                                             invitations: query.get("invitations") ?? 0,
                                             seasons: query.get("seasons") ?? 0, n: query.get("n") ?? 0 }),
    }));
  });

  app.post("/admin/invite", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const email = String(c.form.email ?? "").trim();
    // Says so. This used to redirect with no `?r=`, so submitting the form with the field empty reloaded the
    // Administration page unchanged and told the admin nothing: no new invitation, no message, no clue whether the
    // app had worked. Every other outcome on this screen reports itself, which is what made this one the odd path
    // out rather than a deliberate quiet success.
    //
    // Deliberately NOT a format check. This app sends no email â€” the admin copies the link and delivers it
    // themselves â€” so the address is a label plus the key `linkIdentity` later matches an OIDC claim against, and
    // a wrong one is fixable by editing the person's contact. Rejecting valid-but-unusual addresses would do more
    // harm than accepting a typo, which is the usual outcome of hand-written email validation.
    if (!email) return redirect(res, "/admin?r=no_email");
    const { token, id: invitationId } = createInvite(db, { email });
    // The subject is the invitation, NOT the address. The address lives on the invitation row, which erasure
    // scrubs; a copy here would outlive the person it names, which is what it did until this was fixed.
    logAudit(c, "admin.invite", `invitation:${invitationId}`, "as volunteer");
    // FOURWATER_BASE_URL, never the Host header.
    //
    // This used to build the absolute URL from req.headers.host, for the good reason that a relative path is
    // useless in an email and hardcoding a domain breaks the second department. But an invite token GRANTS A
    // SESSION, and Host is attacker-influencable: a request with a forged Host renders a link on somebody
    // else's origin, the admin emails it in good faith, and the volunteer clicks it and hands their invite to
    // whoever owns that host. It is the poisoned-password-reset-link attack with extra steps.
    //
    // tools/bootstrap.mjs already used FOURWATER_BASE_URL for exactly this, and so does the calendar feed â€”
    // this route was the odd one out, and two link builders with two different policies is the tell. When the
    // variable is unset the page shows the path and says to prefix the address, which is the honest answer:
    // the app does not know its own public name unless somebody tells it.
    // `?? ""` because unset must render the PATH, not the string "null" — see src/config.mjs.
    const base = publicBaseUrl(env) ?? "";
    freshInvites.set(c.personId, `${base}/invite/${token}`);
    redirect(res, "/admin?r=invited");
  });

  app.post("/admin/invite/revoke", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    revokeInvite(db, Number(c.form.id));
    logAudit(c, "admin.revokeInvite", `invitation:${Number(c.form.id)}`, "withdrawn before it was used");
    redirect(res, "/admin?r=revoked");
  });

  app.post("/admin/role", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = setRole(db, Number(c.form.personId), String(c.form.role), c.form.on === "1");
    logAudit(c, "admin.role", `person:${Number(c.form.personId)}`,
             `${c.form.on === "1" ? "granted" : "removed"} ${String(c.form.role)}${r.ok ? "" : ` (refused: ${r.reason})`}`);
    redirect(res, `/admin?r=${r.ok ? "saved" : r.reason}`);
  });

  app.post("/admin/capability", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = setCapability(db, Number(c.form.personId), String(c.form.key), c.form.on === "1", { today: today() });
    logAudit(c, "admin.capability", `person:${Number(c.form.personId)}`,
             `${c.form.on === "1" ? "can" : "cannot"} ${String(c.form.key)}` +
             `${r.ok ? (r.stillHeld ? `, still on ${r.stillHeld} future shift(s) for it` : "") : ` (refused: ${r.reason})`}`);
    // A separate code when they are still rostered for it, so the banner can say so rather than reporting a bare
    // success over shifts somebody now has to look at.
    const code = !r.ok ? r.reason : r.stillHeld ? "capability_kept" : "saved";
    redirect(res, `/admin?r=${code}${r.stillHeld ? `&n=${r.stillHeld}` : ""}`);
  });

  app.post("/admin/status", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = setPersonStatus(db, Number(c.form.personId), String(c.form.status), { today: today() });
    logAudit(c, "admin.status", `person:${Number(c.form.personId)}`,
             `${String(c.form.status)}${r.ok && r.released ? `, released ${r.released} future shifts` : ""}`);
    // Say how many shifts that freed. Reporting "saved" over fifty released shifts is the silence this project
    // keeps closing: the planner is the one who has to fill them, and they have no other way to know.
    if (r.ok && r.released > 0) return redirect(res, `/admin?r=released&n=${r.released}`);
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
        // there is nothing to show later. Held in memory keyed by person, not in the URL â€” a capability URL in
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
      // A wrong token is a failed authentication, so it counts toward the same limiter that guards sign-in â€”
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
      // Without FOURWATER_BASE_URL the path is still correct and the page says to prefix the site address â€”
      // guessing an origin from the Host header would let a proxied request mint a link pointing anywhere.
      const base = publicBaseUrl(env) ?? "";
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
    // on every view â€” and a failure here must not take the status page down with it.
    let oidcState = null;
    if (oidc.enabled) {
      try { oidcState = { enabled: true, ...(await discoverOidc(oidc)) }; }
      catch (e) { oidcState = { enabled: true, source: "fallback", error: e.message }; }
    }
    // `channel` only â€” never the webhook, whose path is the credential. The page needs to know whether one is
    // configured so it does not tell an operator "no webhook is configured" while one plainly is.
    const status = collectStatus(db, {
      pattern: cfg, today: today(), backupDir: backupConfig(env).dir, oidc: oidcState,
      notify: { channel: notifyConfig(env).channel },
      // The nudge job's own account of itself. Optional here for the same reason `notifier` is â€” a test builds
      // an app without a timer â€” and that is exactly how the notifier came to be missing in production, so
      // test/journey.test.mjs asserts this line renders on a real boot rather than trusting this call site.
      jobs,
    });
    send(res, 200, renderStatus({ t, session: c.session, roles: c.roles, who: c.who, status }));
  });

  // The outbox. Without this, every message the app composes with no webhook configured â€” which is the default
  // â€” went into a table nobody could read, and /status could only report the count.
  // Reading the audit trail. Admin only, and the reason is in src/pages/audit.mjs.
  app.get("/audit", ({ req, res, query }) => {
    const c = gate({ req, res }, "admin");
    if (!c) return;
    // A cursor needs BOTH halves to be a cursor. Half of one would page from the wrong place, and on this screen
    // that means quietly skipping rows — so an incomplete pair is treated as no cursor at all.
    //
    // Tested against `Number(query.get(...))`, which looked right and was not: a MISSING parameter is null,
    // Number(null) is 0, and Number.isInteger(0) is true. So `?before=<a date>` with no id built a cursor at id 0
    // and rendered an empty page that looked like an empty log. The raw string has to be checked, not its cast.
    const bAt = query.get("before");
    const rawId = query.get("beforeId") ?? "";
    const before = bAt && /^\d+$/.test(rawId) ? { at: bAt, id: Number(rawId) } : null;

    const rows = listAudit(db, { before });
    const last = rows.at(-1);
    const older = last && hasOlderAudit(db, last) ? { at: last.at, id: last.id } : null;

    send(res, 200, renderAudit({
      t, session: c.session, roles: c.roles, who: c.who, rows,
      labels: describeAudit(db, rows),
      total: countAudit(db),
      retentionDays: retentionConfig(pattern).auditDays,
      older, newest: before === null,
    }));
  });

  app.get("/outbox", ({ req, res, query }) => {
    const c = gate({ req, res }, "planner");
    if (!c) return;
    const wanted = query.get("status");
    const status = ["queued", "failed", "sent"].includes(wanted) ? wanted : null;
    const outbox = listOutbox(db, { status });
    // Derived from `channel`, never from `webhook`. The webhook URL IS the credential â€” its path is the
    // secret â€” so it must not travel into a render function at all, not even to be tested for truthiness.
    send(res, 200, renderOutbox({
      t, roles: c.roles, who: c.who, outbox,
      webhookConfigured: notifyConfig(env).channel !== "outbox",
    }));
  });

  // ---- erasure, export, retention (increment N) ---------------------------------------------------------
  app.post("/admin/erase", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const r = erasePerson(db, Number(c.form.personId), { mode: String(c.form.mode ?? ""), today: today() });
    logAudit(c, "admin.erase", `person:${Number(c.form.personId)}`,
             r.ok ? `${r.mode}, released ${r.released ?? 0}` : `refused: ${r.reason}`);
    if (!r.ok) return redirect(res, `/admin?r=${r.reason === "bad_mode" ? "erase_bad_mode" : r.reason}`);
    redirect(res, `/admin?r=erased&who=${encodeURIComponent(r.was)}&mode=${r.mode}&n=${r.released ?? 0}`);
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
    send(res, 200, exportSeasonCsv(db, sid, { delimiter: exportConfig(cfg).csvDelimiter }), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="4water-${cfg.season.key}.csv"`,
    });
  });

  app.post("/admin/retention", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    // The LIVE config, for the same reason the admin forms use it â€” and here it decides what gets DELETED.
    //
    // This ran with `cfg`, the copy loaded at boot. `retention.seasons` and `retention.notificationDays` are
    // file-only settings, so the way an operator raises them is to edit config/pattern.json. Measured: put four
    // seasons in the database, hand-edit the file to keep six, press "run the clean-up now" without restarting â€”
    // and two seasons were deleted, because the process still believed its own copy said two. The operator raised
    // the number for exactly the purpose the button then defeated.
    //
    // Same shape as tools/backup.mjs reading the wrong config file on its retention step. A destructive action
    // must read the policy that is written down, not the one it happens to remember.
    const live = baseForEdit();
    if (live.__unreadable) return redirect(res, `/admin?r=invalid&m=${encodeURIComponent(live.__unreadable)}`);
    const r = runRetention(db, { pattern: live, currentKey: live.season.key });
    logAudit(c, "admin.retention", null,
             `notifications ${r.notifications.removed}, invitations ${r.invitations.removed}, audit ${r.audit.removed}`);
    // Invitations are reported too. A clean-up that silently deletes a category it does not mention is the same
    // problem as one that never deletes it: the operator cannot tell what happened.
    redirect(res, `/admin?r=retention_done&notifications=${r.notifications.removed}` +
                  `&invitations=${r.invitations.removed}&seasons=${r.seasons.removed.length}`);
  });

  // The base every admin form edits: what is ON DISK, not what this process loaded at boot.
  //
  // Each form does `structuredClone(current)` and `savePattern` writes the clone back, so `current` decides what
  // survives. It was `cfg`, the in-memory copy â€” which meant an operator's hand edit that the process had not
  // picked up was silently destroyed by the next ordinary admin action. Measured: set `notify.remindDaysBefore`
  // in the file, then add a weekly slot from the Administration screen, and the value is GONE. No error, no
  // warning, and the admin who pressed the button has no idea they overwrote anything.
  //
  // RUNBOOK sends an operator to that file for five values â€” the clock times, `board.cutoffDays`,
  // `calendar.eventMinutes`, `export.csvDelimiter`, `notify.remindDaysBefore` â€” so hand edits are not a misuse,
  // they are the documented way to set most of them. Only a value the in-memory copy happened to share survived,
  // which is why `export.csvDelimiter` came through in that measurement and the other did not: the repository
  // config already carries the delimiter.
  //
  // If the file on disk does not parse, this REFUSES rather than falling back to `cfg`. Falling back is the
  // destructive path: it would overwrite a broken file with the process's own idea of the config and destroy
  // whatever the operator was in the middle of typing. `readJson` names the file in its error, so the admin is
  // told which one.
  // `loadPattern` already validates, so this catches both a file that will not parse and one whose contents the
  // app would refuse at boot â€” either way the right answer is to tell the admin rather than write over it.
  const baseForEdit = () => {
    try { return loadPattern(patternFile); }
    catch (e) { return { __unreadable: e.message }; }
  };

  // Every config edit goes through validate-then-atomic-write, then reloads in this process.
  const applyPattern = (next, res, { fromDate = null, okCode = "saved" } = {}) => {
    if (next?.__unreadable) {
      return redirect(res, `/admin?r=invalid&m=${encodeURIComponent(next.__unreadable)}`);
    }
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
    applyPattern(patternFromForm(baseForEdit(), c.form), res);
    logAudit(c, "admin.season", null, "edited the season or activity configuration");
  });

  app.post("/admin/activity", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    applyPattern(addActivityToForm(baseForEdit(), c.form), res);
    logAudit(c, "admin.activity", null, `added activity ${String(c.form.key ?? "?")}`);
  });

  // ---- the weekly rhythm (increment Q) ------------------------------------------------------------------
  // A public holiday, opted back in or out. 4water's rule: no sessions on a holiday by default, and the planner
  // says so explicitly when classes run anyway.
  //
  // Turning it back OFF is the destructive direction — it deletes the sessions created for that date, and a
  // session takes its assignments with it. So it counts first and REFUSES when somebody is on one, rather than
  // silently cancelling on a volunteer who had agreed to teach. That is the same policy as removing a weekly slot,
  // which deliberately leaves existing sessions alone; the difference is that here the whole point is to remove
  // them, so refusing is the only honest guard available.
  app.post("/admin/holiday", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const date = String(c.form.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirect(res, "/admin?r=holiday_bad_date");
    // Inside the season, or there is nothing to close. The form carries min/max so a browser will not offer a date
    // outside it, but a crafted POST can — and accepting one would write a closure into the config for a date the
    // seeder never visits: a config entry that does nothing, which is the "switch wired to no lamp" this project
    // deleted once already.
    const bounds = baseForEdit().season;
    if (date < bounds.from || date > bounds.to) {
      return redirect(res, `/admin?r=holiday_outside&d=${encodeURIComponent(date)}`);
    }
    const on = c.form.on === "1";
    const sid = seasonId();

    if (!on && sid) {
      const existing = sessionsOnDate(db, sid, date);
      if (existing.taken > 0) {
        logAudit(c, "admin.holiday", null, `refused to clear ${date}: ${existing.taken} slots are taken`);
        return redirect(res, `/admin?r=holiday_taken&n=${existing.taken}&d=${encodeURIComponent(date)}`);
      }
    }

    // Whether a TABLE already accounts for this date, so the setter knows if it must write the closure down itself.
    // Asked with classesAnyway emptied, because the question is "does something other than the planner's own opt-in
    // suppress this date" — and `suppressed()` short-circuits on classesAnyway by design.
    const holCfg = holidayConfig(baseForEdit());
    const byTable = suppressed(date, { ...holCfg, classesAnyway: [], extra: [] }) !== null;
    const { pattern: next, changed } = setClassesAnyway(baseForEdit(), date, on, { suppressedByTable: byTable });

    // Deleting has to happen here rather than inside savePattern: seeding only ever ADDS, by a policy this project
    // states twice, so nothing else would ever take the sessions away again.
    //
    // And it runs whether or not the CONFIG changed, which is the case worth spelling out. A deployment that adds
    // `holidays.country` to a season already seeded has sessions on dates that are now holidays: the config says
    // suppressed, the database says otherwise, and the database is the only one volunteers can see. So "no classes
    // after all" has to mean "make the plan match", not "edit a list and hope".
    let removed = 0;
    if (!on && sid) {
      const doomed = sessionsOnDate(db, sid, date);
      if (doomed.sessions > 0) {
        db.prepare("DELETE FROM sessions WHERE season_id=? AND date=?").run(sid, date);
        removed = doomed.sessions;
      }
    }
    if (!changed && removed === 0) return redirect(res, `/admin?r=holiday_unchanged&d=${encodeURIComponent(date)}`);
    logAudit(c, "admin.holiday", null,
             `${on ? "classes run on" : "no classes on"} ${date}${removed ? `, ${removed} sessions removed` : ""}`);

    // fromDate = the date itself, so opting one holiday back in does not re-seed the rest of the season.
    applyPattern(next, res, { fromDate: on ? date : null, okCode: on ? "holiday_on" : "holiday_off" });
  });

  app.post("/admin/weekly/add", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    // Refused explicitly rather than left to `Number("")`, which is 0 â€” so a POST with no `time` silently meant
    // MIDNIGHT and validation accepted it, because 0 is a legal hour. Measured by omitting the field: it created a
    // slot at 00:00 and seeded 26 sessions for it, reporting success. The form marks the input `required` and
    // pre-fills 19:00, so a browser cannot do this â€” but `required` is a client-side courtesy, and the CSRF audit
    // exists in this project precisely because what the server accepts is the only thing that counts.
    //
    // `retention.mjs` already warns about this exact trap in prose: its `atLeastOne` is "written out rather than
    // leaning on `Number(x) || default`, where 0 silently becomes the default". Here 0 was silently a valid answer.
    const time = String(c.form.time ?? "");
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      return redirect(res, `/admin?r=invalid&m=${encodeURIComponent("config: a weekly slot needs a time as hh:mm")}`);
    }
    const [hour, minute] = time.split(":");
    // __all, because the activity checkboxes share one name and Object.fromEntries keeps only the last.
    // Cadence. Absent or "1" means every week and is not written to the config at all; validatePattern bounds it,
    // so a hand-typed 99 is a startup error rather than a slot that quietly runs twice a year.
    const next = addWeeklyToForm(baseForEdit(), {
      dayOfWeek: c.form.dayOfWeek, hour, minute, activities: c.form.__all("activities"),
      everyNth: c.form.everyNth, weekOffset: c.form.weekOffset,
    });
    logAudit(c, "admin.weeklyAdd", null, `day ${String(c.form.dayOfWeek)} at ${time}`);
    // fromDate = today, so adding a slot in August does not manufacture unfilled sessions back to January.
    applyPattern(next, res, { fromDate: today(), okCode: "weekly_added" });
  });

  app.post("/admin/weekly/remove", async ({ req, res }) => {
    const c = await postGate({ req, res }, "admin");
    if (!c) return;
    const { pattern: next, removed } = removeWeeklyFromForm(baseForEdit(), c.form);
    logAudit(c, "admin.weeklyRemove", null, `day ${String(c.form.dayOfWeek)} at ${String(c.form.hour)}:${String(c.form.minute)}`);
    if (removed === 0) return redirect(res, "/admin?r=weekly_not_found");
    applyPattern(next, res, { okCode: "weekly_removed" });
  });

  // How many OTHER people could take this slot â€” the number is what makes the message actionable rather
  // than noise. Uses the same eligibility definition as the board.
  async function announceOpenSlot(assignmentId, detail, { shortNotice = false } = {}) {
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
        // WITH the role. Increment U put "Salsa Â· leader" on the board, the plan and the planner and left the
        // announcement saying only "Salsa" â€” so the one place the message has to stand alone, in a chat channel
        // away from the app, was the one place a volunteer could not tell whether it was theirs to take.
        // formatRole returns "" for a slot with no role, so a workshop reads exactly as it did before.
        activity: `${detail.label}${formatRole(t, detail.role)}`,
        eligible,
        // Read off the notifier rather than threaded through buildApp: makeNotifier already carries the config it
        // was built with, and a second copy of the same value is a second thing to keep in step. Optional-chained
        // because a test may hand in a bare { send } with no config at all.
        publicUrl: notifier.config?.publicUrl ?? null,
        shortNotice,
      }),
    });
  }

  return app;
}

// Entry point. Use pathToFileURL rather than building the URL by hand: on Windows an absolute path becomes
// file:///C:/... with THREE slashes, so `file://${path}` never matches and `node src/server.mjs` exits 0
// having done nothing â€” no error, no output. Caught by running it, not by any unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Cleanly, the same as a failed bind below. openDb now explains itself, but an uncaught throw still buries that
  // explanation under a stack trace naming db.mjs â€” and the operator reading a container log has no use for the
  // line number of a file they are not going to open.
  let db;
  try {
    db = openDb();
  } catch (e) {
    console.error(`\nâœ– ${e.message}\n`);
    process.exit(1);
  }
  migrate(db);

  // Materialise the season from config. This was MISSING and the app booted completely inert â€” no season, no
  // activities, no sessions, every page an empty state â€” because every test builds its world through
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
  if (naked > 0) console.warn(`âš  ${naked} session(s) have no slots â€” the plan will look populated and be unusable.`);

  // Say so loudly if nobody can get in yet, rather than serving a working-looking app that refuses everyone.
  const admins = db.prepare(`SELECT COUNT(*) n FROM person_roles pr JOIN roles r ON r.id = pr.role_id
                              WHERE r.name = 'admin'`).get().n;
  if (admins === 0) {
    console.warn(`\nâš  There is no administrator yet, so nobody can sign in or invite anyone.`);
    console.warn(`  Create the first one:  node tools/bootstrap.mjs <email> "<name>"\n`);
  }
  // The notifier and the nudge timer, WIRED HERE, because nothing else does it.
  //
  // Until this existed, makeNotifier and startJobs were called only from tests. buildApp defaults notifier to
  // null and announceOpenSlot opens with `if (!notifier) return`, so on a real deployment no "a shift became
  // free" announcement ever fired and the availability nudge never ran once â€” while seventeen tests proved the
  // machinery worked, because the test harness passed a notifier that production did not. Same generator as the
  // missing slots: the harness doing setup the real boot path skipped.
  //
  // With no MATTERMOST_WEBHOOK the channel is the outbox, which is not a degraded mode â€” messages are written
  // and a planner reads them at /outbox. That is the default and it is fine; silence was the bug.
  const notifyCfg = notifyConfig(process.env);
  const notifier = makeNotifier({ db, config: notifyCfg });
  const bootT = makeT(boot.locale ?? "en");
  // The LIVE pattern, not the booted one. `boot` is loaded once and never reassigned, so a season getter closed
  // over it goes stale the moment an admin rolls the season over from the Administration screen â€” and both
  // notification features then work a season that is entirely in the past. buildApp calls `onPatternChange` from
  // its reloadPattern, which is the only thing that keeps this in step.
  let live = boot;
  const currentSeasonId = () => db.prepare("SELECT id FROM seasons WHERE key = ?").get(live.season.key)?.id ?? null;
  // The formatters go in from here, where the view layer is already imported. jobs.mjs contains no date wording
  // and no role vocabulary on purpose, and a shift reminder that read "2026-03-15 19:00 Salsa l" would be worse
  // than none â€” it is read in a chat channel with none of the app's context around it.
  const jobs = startJobs({
    db, notifier, t: bootT, seasonId: currentSeasonId,
    today: () => new Date().toISOString().slice(0, 10),
    remindDaysBefore: notifyTimingConfig(boot).remindDaysBefore,
    formatDate, formatTime, formatRole,
  });
  console.log(`notifications: ${notifyCfg.describe()}`);   // describe() never reveals the URL â€” its path is the secret

  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || "127.0.0.1";
  const server = buildApp({
    db, pattern: boot, patternFile: configFile, notifier, jobs,
    // Without this the nudge and the shift reminders keep working the season that was current when the process
    // started. `remindDaysBefore` is deliberately NOT re-read: nothing in the admin screen can change it, so a
    // file edit plus a restart is the only way to set it and boot-capture is the honest behaviour there.
    onPatternChange: (next) => {
      live = next;
      console.log(`config reloaded: season ${next.season.key}`);
    },
  }).listen(port, host, () => console.log(`4water listening on http://${host}:${port}`));

  // listen() is ASYNCHRONOUS, so the success line has to be its callback. Printed on the next statement â€” which
  // it was â€” the app announces "4water listening on ..." and then dies of EADDRINUSE, and the log reads as a
  // clean start followed by an unrelated crash. That is exactly how a stale copy of this app on the same port
  // cost a round of debugging: the output said it was up, so the wrong process got measured.
  //
  // The address is also the real one now. The old line hardcoded 127.0.0.1 while the container binds 0.0.0.0,
  // so it described something other than what happened.
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nâœ– ${host}:${port} is already in use â€” another copy is probably still running.`);
      console.error(`  Stop that one, or choose another port:  PORT=${port + 1} node src/server.mjs\n`);
    } else if (err.code === "EACCES") {
      console.error(`\nâœ– Not allowed to bind ${host}:${port}. Ports below 1024 need privileges; use a proxy instead.\n`);
    } else {
      console.error(`\nâœ– Could not start: ${err.message}\n`);
    }
    process.exit(1);
  });

  // Run the nudge check once shortly after boot as well as on the interval. Six hours is a long time to wait to
  // find out the job is misconfigured, and runNudge is idempotent per (kind, person, period) so an extra call
  // cannot produce an extra message.
  setTimeout(() => { jobs.tick().catch(() => {}); }, 5_000).unref?.();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => { jobs.stop(); server.close(); db.close(); process.exit(0); });
  }
}
