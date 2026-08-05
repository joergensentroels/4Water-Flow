// The page shell and shared formatting. Every user-visible string comes through `t`, so this file names no
// weekday and no activity — test/seams.test.mjs enforces that.
import { html, raw } from "./http.mjs";

// A water droplet, drawn here rather than fetched. Two reasons, both hard requirements: the Content-Security-
// Policy is `img-src 'self'`, so nothing loads from 4water.org even if we wanted it to — and their actual logo
// file is their asset, not ours to copy into an unrelated repository. This is a nod to the identity, not a
// reproduction of the mark. aria-hidden because the <h1> beside it already says the name; a screen reader
// announcing "image" here would add a word and no information.
const DROPLET = raw(`<svg class="drop" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M12 2.2S5.2 9.9 5.2 14.3a6.8 6.8 0 0 0 13.6 0C18.8 9.9 12 2.2 12 2.2z" fill="currentColor"/>
  <path d="M9.4 14.6a2.6 2.6 0 0 0 2.2 2.5" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round"/>
</svg>`);

export function layout({ t, title, who, nav = [], flash, body }) {
  return html`<!doctype html>
<html lang="${t("html.lang")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ${t("app.title")}` : t("app.title")}</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header class="bar">
  ${DROPLET}
  <h1>${t("app.title")}</h1>
  ${who ? html`<span class="who">${who}</span>` : ""}
</header>
${nav.length ? html`<nav class="tabs">${nav.map((n) =>
  html`<a href="${n.href}"${n.current ? raw(' aria-current="page"') : ""}>${n.label}</a>`)}</nav>` : ""}
<main>
  ${flash ? html`<p class="flash ${flash.bad ? "bad" : ""}">${flash.text}</p>` : ""}
  ${body}
</main>
</body>
</html>`;
}

// A date as "<weekday> <d>/<m>" using the locale's weekday name. Intl would also do this, but it would put
// the department's language in the hands of the server's locale data rather than strings/, and the whole
// point of the seams is that translation lives in one reviewable place.
export function formatDate(t, iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${t.weekday(d.getUTCDay())} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

export const formatTime = (hour, minute = 0) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

// How a role reads on a slot. Empty string when the slot has no role, so a workshop does not acquire a
// meaningless "(any)" — the absence of a role requirement is information, not a value to print.
export const formatRole = (t, role) => (role ? ` · ${t(`role.dance.${role}`)}` : "");

export const csrfField = (session) => html`<input type="hidden" name="csrf" value="${session.csrf}">`;

// Error pages. Every one gets the real layout, an explanation in the user's language, and a link out — a dead
// end with no navigation is what a browser pass found on the 403, and the same was true of 404 and 405.
const ERROR_KEY = {
  400: "error.badRequest",
  403: "error.forbidden",
  404: "error.notFound",
  405: "error.notFound",
  413: "error.tooBig",
  429: "error.tooMany",
  500: "error.server",
};

// `messageKey` overrides the default for a status that has more than one honest cause: a 403 from a stale
// CSRF token is almost always a form left open overnight, and telling that person "you do not have access"
// sends them to find an admin instead of pressing the button again.
export function renderErrorPage(t, status, { signedIn = true, messageKey = null } = {}) {
  const key = messageKey ?? ERROR_KEY[status] ?? "error.server";
  return layout({
    t,
    title: String(status),
    body: html`
      <p class="empty">${t(key)}</p>
      <p><a class="btn secondary" href="${signedIn ? "/" : "/signin"}">${t(signedIn ? "nav.home" : "signin.title")}</a></p>`,
  }).__raw;
}

export function navFor(t, roles, current) {
  const items = [
    { href: "/", label: t("nav.home"), key: "home" },
    { href: "/availability", label: t("nav.availability"), key: "availability" },
    { href: "/board", label: t("nav.board"), key: "board" },
    { href: "/plan", label: t("nav.plan"), key: "plan" },
  ];
  items.push({ href: "/me", label: t("nav.profile"), key: "profile" });
  if (roles.includes("planner") || roles.includes("admin")) {
    items.push({ href: "/planner", label: t("nav.planner"), key: "planner" });
    items.push({ href: "/status", label: t("nav.status"), key: "status" });
  }
  if (roles.includes("admin")) {
    items.push({ href: "/admin", label: t("nav.admin"), key: "admin" });
    // The audit trail. In the nav rather than tucked inside Administration because a screen reachable only from
    // another screen's small print is how the outbox stayed unread — and this one exists to be looked at.
    items.push({ href: "/audit", label: t("nav.audit"), key: "audit" });
  }
  return items.map((i) => ({ ...i, current: i.key === current }));
}

// The invitation landing page. Its whole reason for existing is that it does NOT accept the invitation — a GET of
// the emailed link used to redeem it, so a mail gateway fetching that link to scan it spent the invitation and
// locked the volunteer out. Accepting is a POST, which nothing fetches on anybody's behalf.
//
// The address is shown because an invitation is addressed to somebody. A person sent a forwarded link should be
// able to see it is not theirs before taking an account with another volunteer's address on it.
export function renderInvite({ t, token, email }) {
  return layout({
    t,
    title: t("invite.title"),
    nav: [],
    body: html`
      <h2>${t("invite.title")}</h2>
      <div class="card">
        <p>${t("invite.intro", { email })}</p>
        <p class="hint">${t("invite.hint")}</p>
        <form method="post" action="/invite/${token}/accept">
          <button type="submit">${t("invite.accept")}</button>
        </form>
      </div>`,
  });
}

// The volunteer-facing privacy notice. Deliberately short and in their language: docs/PRIVACY.md is the
// board's document, and pointing a volunteer at a markdown file full of GDPR vocabulary is not telling them
// anything. Gap 5 of that document was that nobody was told at all.
export function renderPrivacy({ t, roles = [], signedIn = false }) {
  return layout({
    t,
    title: t("privacy.title"),
    nav: signedIn ? navFor(t, roles, null) : [],
    body: html`
      <h2>${t("privacy.title")}</h2>
      <div class="card">
        <p>${t("privacy.what")}</p>
        <p>${t("privacy.why")}</p>
        <p>${t("privacy.who")}</p>
        <p>${t("privacy.calendar")}</p>
        <!-- Attendance and the audit trail are both statements OTHER PEOPLE make about a volunteer, which is why
             they belong on the page the volunteer reads and not only in the board's document. This page listed
             neither for one commit — the same omission as docs/PRIVACY.md, one screen closer to the person. -->
        <p>${t("privacy.attendance")}</p>
        <!-- Free text is the one kind of personal data erasure cannot reach field by field, so the volunteer is
             told what it can and cannot do rather than left to assume the usual completeness. -->
        <p>${t("privacy.notes")}</p>
        <p>${t("privacy.changes")}</p>
        <p>${t("privacy.rights")}</p>
      </div>
      <p><a class="btn secondary" href="${signedIn ? "/availability" : "/signin"}">${t("privacy.back")}</a></p>`,
  });
}
