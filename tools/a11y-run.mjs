// Walk the app as three different people and audit every screen each of them can reach.
//
// Three, not one, because half this app is conditional on role and on state: the planner's proposal controls do not
// render until proposals exist, and a volunteer who has answered nothing sees a different home screen from one who
// has. A single-viewer pass is exactly how the manual review reached three false conclusions.
//
//   run:  node tools/a11y-run.mjs
import { makeWorld, makeAvailableEverywhere } from "./testkit.mjs";
import { autoRoster } from "../src/roster.mjs";
import { auditHtml, reportText } from "./a11y.mjs";

const w = await makeWorld({ volunteers: 4, roles: { 0: ["admin", "planner"] } });
const pages = [];
const audit = async (name, path, cookie) => {
  const res = await w.get(path, cookie);
  const html = await res.text();
  const r = await auditHtml(html);
  pages.push({ name: `${name}  (${path}, HTTP ${res.status})`, ...r });
};

try {
  const fresh = w.people[3];                       // has answered nothing
  const answered = w.people[1];
  makeAvailableEverywhere(w.db, answered, w.today);
  const admin = await w.signIn(w.people[0]);
  const cFresh = await w.signIn(fresh);
  const cAnswered = await w.signIn(answered);

  // A volunteer who has answered nothing — the state the whole rota is waiting on.
  for (const [name, path] of [["home (unanswered)", "/"], ["availability (unanswered)", "/availability"],
                              ["board (unanswered)", "/board"], ["plan", "/plan"], ["profile", "/me"],
                              ["privacy", "/privacy"], ["404", "/no-such-page"]]) {
    await audit(name, path, cFresh);
  }
  // The same screens for somebody who HAS answered: different empty states, different prompts.
  await audit("home (answered)", "/", cAnswered);
  await audit("availability (answered)", "/availability", cAnswered);
  await audit("board (answered)", "/board", cAnswered);

  // Planner and admin, first with nothing proposed and then with proposals — the controls are conditional.
  await audit("planner (no proposals)", "/planner", admin);
  autoRoster(w.db, { seasonId: w.seasonId, fromDate: w.today });
  await audit("planner (with proposals)", "/planner", admin);
  for (const [name, path] of [["status", "/status"], ["admin", "/admin"], ["audit log", "/audit"],
                              ["outbox", "/outbox"]]) {
    await audit(name, path, admin);
  }
  // Signed out.
  await audit("sign-in", "/signin", undefined);

  console.log(reportText(pages));
  const total = pages.reduce((n, p) => n + p.violations.length, 0);
  process.exitCode = total > 0 ? 1 : 0;
} finally { w.close(); }
