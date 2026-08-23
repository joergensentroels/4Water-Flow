// Stand up a demo instance somebody else can actually try, over a real HTTPS URL.
//
//   node tools/demo-serve.mjs https://plan-demo.example.ts.net:8444 you@example.org "Your Name"
//
// It builds the demo database, prints the environment to start the app with, creates an administrator you can
// sign in as, and gives that person capabilities so the screens have content. It does NOT start the server or
// touch your reverse proxy: what fronts this with TLS is the operator's business, the same rule the app itself
// follows by binding to loopback.
//
// ---------------------------------------------------------------------------------------------------
// WHY THIS EXISTS RATHER THAN A PARAGRAPH IN THE RUNBOOK.
//
// Item 3 of "what would make it 1.0.0" is "No volunteer has used it — every usability judgement is reasoned
// from the reported pain, not observed". Retiring that needs somebody's thumb on a phone, and the distance
// between `npm test` and that is a series of steps each of which has a way to go quietly wrong. Three of them
// were found by walking it:
//
//   1. NODE_ENV=production sets the Secure flag on the session cookie (src/server.mjs), and a browser REFUSES
//      to store a Secure cookie over plain http. Sign-in then appears to work and bounces straight back to the
//      sign-in page. curl does not enforce this and localhost is exempt, so neither the test suite nor a
//      browser on the serving machine can show you the failure — only a phone can, at the worst moment.
//      Hence BASE_URL is required here and must be https, unless it is loopback.
//
//   2. FOURWATER_BASE_URL is what makes the invitation link an absolute URL. Without it the link is a PATH,
//      which cannot be opened on another device at all.
//
//   3. A freshly bootstrapped administrator has no capabilities, so the shift exchange correctly reports that
//      there is nothing to offer them. Accurate, and a poor thing to hand somebody who was asked to try
//      claiming a shift. This grants them, which is what an admin would have done from the Administration
//      screen anyway.
//
// The demo database holds invented people with example.invalid addresses. It is not 4water's roster, and
// nothing here should ever be pointed at a database that is.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../src/db.mjs";
import { loadPattern } from "../src/config.mjs";
import { bootstrapAdmin } from "./bootstrap.mjs";
import { setCapability } from "../src/admin.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [baseUrl, email, name, appPortArg] = process.argv.slice(2);

// The app's port is NOT the port in the base URL, and conflating them is a live trap: the URL's port is what
// the TLS proxy listens on publicly, while the app listens on the loopback port the proxy forwards TO. The
// first version of this printed PORT=8444 from the URL — the same port `tailscale serve` was already bound to,
// so following its own instructions would have failed to bind, at a meeting, in front of people.
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

// The port collision, refused rather than printed. Following instructions that told the app to bind the port
// the proxy is already holding fails at the worst possible moment, and the error it produces — EADDRINUSE —
// names neither the proxy nor this script.
if (!loopback && u.port && Number(u.port) === APP_PORT) {
  die(`the app port and the base URL port are both ${APP_PORT}.\n\n`
    + "The base URL's port belongs to the TLS proxy. The app has to listen on a DIFFERENT loopback port for the\n"
    + "proxy to forward to, or it will fail to bind. Pass one as the fourth argument, e.g. 8080.");
}

const DB = path.join(ROOT, "demo.db");
const PATTERN = "demo-pattern.json";

console.log("building the demo database…");
execFileSync(process.execPath, [path.join(ROOT, "tools", "demo.mjs")], { cwd: ROOT, stdio: "inherit" });

const db = openDb(DB);
migrate(db);
// At the repository ROOT, not under config/ — which is where FOURWATER_PATTERN resolves it from, and where
// tools/demo.mjs writes it. Getting this wrong is an immediate ENOENT rather than anything subtle.
const pattern = loadPattern(path.join(ROOT, PATTERN));
const r = bootstrapAdmin(db, { email, name: name || email, baseUrl, roles: pattern.roles });
if (!r.ok) die(`could not create the administrator: ${r.reason}`);

// Every activity in the pattern, so the exchange and the availability screens have something to show. An admin
// would grant these from the Administration screen; doing it here means the person handed the phone does not
// meet an empty screen that is technically correct.
const granted = [];
for (const a of pattern.activities || []) {
  if (setCapability(db, r.personId, a.key, true).ok) granted.push(a.key);
}
db.close();

const q = (s) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
console.log(`\n${"─".repeat(96)}`);
console.log(`administrator: ${email} (person ${r.personId}) — capabilities: ${granted.join(", ") || "none"}`);
console.log(`\n1. Start the app on 127.0.0.1:${APP_PORT}`
  + `${loopback ? " (no proxy needed for a loopback URL)" : ` — whatever serves ${u.origin} must forward to it`}:\n`);
console.log(`   NODE_ENV=production FOURWATER_DB=${q(DB)} FOURWATER_PATTERN=${PATTERN} \\`);
console.log(`     FOURWATER_BASE_URL=${q(baseUrl)} HOST=127.0.0.1 PORT=${APP_PORT} \\`);
console.log(`     FOURWATER_SECRET=<32+ hex chars, openssl rand -hex 32> node src/server.mjs`);
console.log(`\n   The app refuses to start without FOURWATER_SECRET rather than using a guessable default.`);
console.log(`\n2. Open this once, on the device you mean to demo from:\n`);
console.log(`   ${r.inviteUrl}`);
console.log(`\n   Single use, 14 days. Opening it does not spend it — only the button does, so a mail scanner`);
console.log(`   fetching the link cannot consume the invitation.`);
console.log(`${"─".repeat(96)}\n`);
