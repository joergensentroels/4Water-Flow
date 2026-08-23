// Stand up a demo instance somebody else can actually try, over a real HTTPS URL.
//
//   node tools/demo-serve.mjs https://plan-demo.example.ts.net:8444 you@example.org "Your Name" [app-port]
//
// It builds the demo database, creates an administrator you can sign in as, gives that person capabilities so
// the screens have content, and prints the environment to start the app with. It does NOT start the server or
// touch your reverse proxy: what fronts this with TLS is the operator's business, the same rule the app itself
// follows by binding to loopback.
//
// ---------------------------------------------------------------------------------------------------
// WHY THIS EXISTS RATHER THAN A PARAGRAPH IN THE RUNBOOK.
//
// Item 3 of "what would make it 1.0.0" is "No volunteer has used it — every usability judgement is reasoned
// from the reported pain, not observed". Retiring that needs somebody's thumb on a phone, and the distance
// between `npm test` and that is a series of steps each of which has a way to go quietly wrong. Every one of
// these was found by walking it, not by reading it:
//
//   1. NODE_ENV=production sets the Secure flag on the session cookie (src/server.mjs), and a browser REFUSES
//      to store a Secure cookie over plain http. Sign-in then appears to work and bounces straight back to the
//      sign-in page. curl does not enforce this and localhost is exempt as a secure context, so neither the
//      test suite nor a browser on the serving machine can show you the failure — only another device can, at
//      the worst moment. Hence the base URL is required here, and must be https unless it is loopback.
//
//   2. FOURWATER_BASE_URL is what makes the invitation link an absolute URL. Without it the link is a PATH,
//      which cannot be opened on another device at all.
//
//   3. A freshly bootstrapped administrator has no capabilities, so the shift exchange correctly reports that
//      there is nothing to offer them. Accurate, and a poor thing to hand somebody who was asked to try
//      claiming a shift. This grants them, which is what an admin would have done from the Administration
//      screen anyway.
//
//   4. The app port is NOT the port in the base URL. The URL's port belongs to the TLS proxy; the app listens
//      on the loopback port the proxy forwards TO. The first version of this printed the URL's port as PORT,
//      so following its own instructions would have failed to bind — at a meeting, in front of people.
//
//   5. demo.mjs's own output must not be inherited. See the discard below; it is a safety property.
//
// The demo database holds invented people with example.invalid addresses. It is not 4water's roster, and
// nothing here should ever be pointed at a database that is.
//
// SIDE EFFECTS ARE BEHIND THE MAIN GUARD, so importing this for demoInstructions() does not rebuild a
// database. That is not hypothetical carefulness: a sibling tool in another repository printed its whole
// report at import time and took a test suite down with it.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { bootstrapAdmin } from "./bootstrap.mjs";
import { setCapability } from "../src/admin.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB = path.join(ROOT, "demo.db");
const PATTERN = "demo-pattern.json";

// A PURE function, so the one thing that must never appear in these instructions can be asserted without
// building a database or starting a server. test/docs.test.mjs calls it and fails if it ever names
// FOURWATER_AUTH — printing the dev-sign-in command beside a tailnet URL is the exact mistake this script made
// once, and a comment saying "do not do that again" is not a check.
export function demoInstructions({ email, personId, granted, dbPath, pattern, baseUrl, inviteUrl, appPort,
                                   loopback, origin, people, sessions, season }) {
  const q = (s) => (/[\s"]/.test(String(s)) ? JSON.stringify(s) : String(s));
  const rule = "─".repeat(96);
  return [
    "",
    rule,
    `demo data: ${people} people, ${sessions} sessions${season ? `, season ${season}` : ""}`,
    `administrator: ${email} (person ${personId}) — capabilities: ${(granted || []).join(", ") || "none"}`,
    "",
    `1. Start the app on 127.0.0.1:${appPort}`
      + (loopback ? " (no proxy needed for a loopback URL)" : ` — whatever serves ${origin} must forward to it`) + ":",
    "",
    `   NODE_ENV=production FOURWATER_DB=${q(dbPath)} FOURWATER_PATTERN=${pattern} \\`,
    `     FOURWATER_BASE_URL=${q(baseUrl)} HOST=127.0.0.1 PORT=${appPort} \\`,
    `     FOURWATER_SECRET=<32+ hex chars, openssl rand -hex 32> node src/server.mjs`,
    "",
    "   The app refuses to start without FOURWATER_SECRET rather than using a guessable default. And",
    "   NODE_ENV=production is not decoration: it disables the developer sign-in outright, so the invite link",
    "   below is the only way in.",
    "",
    "2. Open this once, on the device you mean to demo from:",
    "",
    `   ${inviteUrl}`,
    "",
    "   Single use, 14 days. Opening it does not spend it — only the button does, so a mail scanner fetching",
    "   the link cannot consume the invitation.",
    rule,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [baseUrl, email, name, appPortArg] = process.argv.slice(2);
  const APP_PORT = Number(appPortArg || 8080);
  const die = (msg) => { console.error(msg); process.exit(2); };

  if (!baseUrl || !email) {
    die('usage: node tools/demo-serve.mjs <base-url> <email> "<name>" [app-port]\n'
      + '       e.g. node tools/demo-serve.mjs https://box.example.ts.net:8444 you@example.org "Your Name"\n'
      + "       app-port defaults to 8080. It is the LOOPBACK port the TLS proxy forwards to — NOT the port in\n"
      + "       the base URL, which belongs to the proxy itself.");
  }
  let u;
  try { u = new URL(baseUrl); } catch { die(`"${baseUrl}" is not a URL`); }
  // The Secure-cookie trap, refused up front rather than discovered on somebody's phone. Loopback is exempt
  // because browsers treat it as a secure context, which is exactly why it cannot be used to test this.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !loopback) {
    die(`${baseUrl} is not https.\n\n`
      + "Under NODE_ENV=production the session cookie carries the Secure flag, and a browser will not store it\n"
      + "over plain http — sign-in will look like it worked and drop you back at the sign-in page. Put a TLS\n"
      + "proxy in front (on a Tailscale tailnet, `tailscale serve --bg --https <port> http://127.0.0.1:8080`\n"
      + "issues a real certificate), or pass a loopback URL if you only mean to test on this machine.");
  }
  if (!/.+@.+/.test(email)) die(`"${email}" is not an email address`);
  // Following instructions that tell the app to bind the port the proxy already holds fails with EADDRINUSE,
  // which names neither the proxy nor this script.
  if (!loopback && u.port && Number(u.port) === APP_PORT) {
    die(`the app port and the base URL port are both ${APP_PORT}.\n\n`
      + "The base URL's port belongs to the TLS proxy. The app has to listen on a DIFFERENT loopback port for\n"
      + "the proxy to forward to, or it will fail to bind. Pass one as the fourth argument, e.g. 8080.");
  }

  // demo.mjs's output is DISCARDED, not inherited, and that is a safety property rather than tidiness.
  //
  // It ends by printing how to start the app for local development — `FOURWATER_AUTH=dev …` — which is right
  // for its own purpose and dangerous here. Inherited, it appeared ABOVE this script's production
  // instructions, so the first start command an operator read was the one enabling passwordless sign-in as any
  // of the twelve demo people, on a URL a whole tailnet can reach. Two contradictory instructions, wrong one
  // first.
  //
  // Discarded wholesale rather than filtered: a denylist for the offending line silently stops working when
  // the wording changes, and what comes back is the dangerous line. Everything worth knowing is re-derived
  // from the database below, where this script owns the words.
  console.log("building the demo database…");
  execFileSync(process.execPath, [path.join(ROOT, "tools", "demo.mjs")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });

  const db = openDb(DB);
  migrate(db);
  // At the repository ROOT, not under config/ — which is where FOURWATER_PATTERN resolves it from, and where
  // tools/demo.mjs writes it. Getting this wrong is an immediate ENOENT rather than anything subtle.
  const pattern = loadPattern(path.join(ROOT, PATTERN));
  const r = bootstrapAdmin(db, { email, name: name || email, baseUrl, roles: pattern.roles });
  if (!r.ok) die(`could not create the administrator: ${r.reason}`);

  // Every activity in the pattern, so the exchange and availability screens have something to show. An admin
  // would grant these from the Administration screen; doing it here means the person handed the phone does not
  // meet an empty screen that is technically correct.
  const granted = [];
  for (const a of pattern.activities || []) {
    if (setCapability(db, r.personId, a.key, true).ok) granted.push(a.key);
  }
  const people = db.prepare("SELECT COUNT(*) c FROM people").get().c;
  const sessions = db.prepare("SELECT COUNT(*) c FROM sessions").get().c;
  const season = db.prepare("SELECT key FROM seasons ORDER BY id DESC LIMIT 1").get()?.key || "";
  db.close();

  console.log(demoInstructions({
    email, personId: r.personId, granted, dbPath: DB, pattern: PATTERN, baseUrl, inviteUrl: r.inviteUrl,
    appPort: APP_PORT, loopback, origin: u.origin, people, sessions, season,
  }));
}
