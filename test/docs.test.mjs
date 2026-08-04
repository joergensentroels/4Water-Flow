// The documents, checked against the code.
//
// Four stale claims have turned up in this project one at a time, each found by accident: docs/PRIVACY.md telling
// the board four gaps were open after they had been closed; three UI strings asserting causes that were false;
// RUNBOOK quoting a webhook timeout the code no longer used, twenty minutes after I wrote it; and RUNBOOK calling
// CI a thing that had happened when it had never run. Prose fails exactly like code, and unlike code it is never
// re-executed — so nothing catches it.
//
// This checks only claims a machine can settle: a file path, a route, an environment variable, a config key, an
// exported name. "The app is phone-first" is not checkable here and is not the point. What IS the point is that
// the handover documents cannot quietly drift away from the software they describe.
//
// Deliberately NOT checked here: PLAN.md's "N tests green". Knowing the real number means running the suite, and
// spawning it from inside itself does not terminate — several tests spawn child servers, and spawnSync waits for
// every inherited pipe to close, so a grandchild that outlives the runner holds one open forever. That claim is
// checked by hand when the number changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

const DOCS = ["README.md", "RUNBOOK.md", "CONTRIBUTING.md", "PLAN.md", "docs/PRIVACY.md", "docs/OIDC.md"];
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

function sourceFacts() {
  const files = [];
  const walk = (rel) => {
    for (const f of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (f.isDirectory()) walk(`${rel}/${f.name}`);
      else files.push(`${rel}/${f.name}`);
    }
  };
  for (const d of ["src", "tools", "test"]) walk(d);
  const all = files.filter((f) => f.endsWith(".mjs")).map(read).join("\n");
  return {
    all,
    routes: new Set([...all.matchAll(/app\.(get|post)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`)),
    exported: new Set([...all.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1])),
    env: new Set([...all.matchAll(/(?:env|process\.env)[.[]"?(FOURWATER_\w+|OIDC_\w+|MATTERMOST_\w+)"?\]?/g)].map((m) => m[1])),
    configKeys: (() => {
      const seen = new Set();
      const rec = (o, prefix = "") => {
        for (const [k, v] of Object.entries(o)) {
          if (k === "_comment") continue;
          seen.add(prefix + k);
          if (v && typeof v === "object" && !Array.isArray(v)) rec(v, `${prefix}${k}.`);
        }
      };
      rec(JSON.parse(read("config/pattern.json")));
      return seen;
    })(),
  };
}

// One place may state the test count, and it is PLAN.md.
//
// Three documents used to, and when this was written all three disagreed with reality at once: RUNBOOK said
// "129+ automated checks", RUNBOOK said "330 tests" further down, PLAN said "330", and the suite had 338. My own
// doc-claims sweep missed two of them because it only matched PLAN's exact phrasing — a checker with a blind spot
// shaped like the thing it was checking.
//
// The count cannot be verified from inside the suite (running it from within itself does not terminate — see the
// note at the top of this file), so this asserts the STRUCTURE instead: exactly one document may carry a number,
// which makes the external check a single-place check rather than a hunt. Same fix as the Node floor and the
// webhook timeout — one fact, one home.
test("only PLAN.md states a test count, so there is one number to keep true", () => {
  const COUNTISH = /\b\d{2,4}\+?\s+(?:automated\s+)?(?:tests?|checks?)\b/gi;
  const offenders = [];
  for (const doc of DOCS) {
    const hits = [...read(doc).matchAll(COUNTISH)].map((m) => m[0].trim());
    if (!hits.length) continue;
    if (doc === "PLAN.md") {
      assert.equal(hits.length, 1, `PLAN.md must state the count exactly once, found: ${hits.join(", ")}`);
      continue;
    }
    offenders.push(`${doc}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, [],
    `these documents state a test count as well as PLAN.md, so at least one of them will be stale:\n  ` +
    `${offenders.join("\n  ")}\n  Say "the whole suite" instead, and leave the number to PLAN.md.`);
});

// The commands the RUNBOOK tells an operator to type, checked against what exists.
//
// This is the least-verified part of the whole project: the image has never been built, so nothing has ever run a
// `docker compose` line from these documents. Everything referenced does currently exist — checked by hand — and
// the point of pinning it is that renaming a compose service or a volume would leave the succession plan quietly
// wrong, in the file somebody reads precisely when they are least able to debug it.
test("every service, volume and port the documents tell an operator to use actually exists", () => {
  const compose = read("compose.yml");
  // Service keys are two-space indented under `services:`; volumes are declared in their own top-level block.
  const services = new Set([...compose.matchAll(/^ {2}([a-z][\w-]*):/gm)].map((m) => m[1]));
  const volumes = new Set([...compose.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]));
  assert.ok(services.has("app"), "compose.yml must define the app service this test reasons about");

  const problems = [];
  let checked = 0;
  for (const doc of DOCS) {
    const text = read(doc);

    // `docker compose <verb> [flags] <service>`. Stops at a BACKTICK as well as a newline: these appear both in
    // fenced blocks and as inline spans mid-sentence, and matching to end-of-line swallowed the closing backtick
    // plus the prose after it — so `docker compose logs app` looked like it named no service, because `app` was
    // followed by a backtick rather than whitespace. Three false positives before this was corrected.
    for (const m of text.matchAll(/docker compose (?:run|exec|stop|start|restart|logs)[^\n`]*/g)) {
      const line = m[0];
      const named = [...services].filter((s) => new RegExp(`(?:^|\\s)${s}(?:\\s|$)`).test(line));
      checked++;
      if (!named.length) problems.push(`${doc}: names no known compose service:\n    ${line.trim()}`);
    }

    // Named volumes, which is how the restore procedure reaches /data.
    for (const m of text.matchAll(/-v ([\w-]+):\//g)) {
      checked++;
      if (!volumes.has(m[1])) problems.push(`${doc}: uses volume "${m[1]}", which compose.yml does not declare`);
    }

    // The port an operator curls has to be the one the image publishes, or the health check they are told to run
    // reports a failure that is entirely their tooling.
    for (const m of text.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/healthz/g)) {
      checked++;
      const published = compose.match(/127\.0\.0\.1:(\d+):\d+/)?.[1];
      if (m[1] !== published) {
        problems.push(`${doc}: says to curl port ${m[1]}, but compose publishes ${published}`);
      }
    }
  }
  assert.ok(checked >= 5, `only ${checked} operator commands were checked — this is not looking properly`);
  assert.deepEqual(problems, [], `the succession plan tells an operator to use things that do not exist:\n  ` +
    `${problems.join("\n  ")}`);
});

test("every claim the documents make about the code is true", () => {
  const facts = sourceFacts();
  const problems = [];
  let checked = 0;
  const claim = (ok, message) => { checked++; if (!ok) problems.push(message); };

  for (const doc of DOCS) {
    assert.ok(existsSync(path.join(ROOT, doc)), `${doc} is in this check's list but does not exist`);
    const text = read(doc);

    for (const m of text.matchAll(/`((?:src|tools|test|config|strings|static|docs)\/[\w./-]+)`/g)) {
      claim(existsSync(path.join(ROOT, m[1])), `${doc} names ${m[1]}, which does not exist`);
    }

    for (const m of text.matchAll(/`(GET|POST) (\/[\w/:.-]*)`/g)) {
      const wanted = `${m[1]} ${m[2]}`;
      // Compared with parameter names normalised, so documenting /invite/:token against a route declared
      // /invite/:tok is not a failure — the shape is the claim, not the variable name.
      const norm = (s) => s.replace(/:[\w]+/g, ":x");
      claim([...facts.routes].some((r) => norm(r) === norm(wanted)),
        `${doc} documents route ${wanted}, which is not registered`);
    }

    for (const m of text.matchAll(/`(FOURWATER_\w+|OIDC_\w+|MATTERMOST_\w+)`/g)) {
      claim(facts.env.has(m[1]), `${doc} documents ${m[1]}, which nothing reads`);
    }

    for (const m of text.matchAll(/`((?:season|calendar|board|export|notify|retention)\.[\w.]+)`/g)) {
      // Either it is in the shipped config, or the code reads that name — an optional setting a deployment has
      // not set is legitimately documented and legitimately absent from config/pattern.json.
      const leaf = m[1].split(".").pop();
      claim(facts.configKeys.has(m[1]) || new RegExp(`\\b${leaf}\\b`).test(facts.all),
        `${doc} documents config ${m[1]}, which is neither in config/pattern.json nor read anywhere`);
    }

    for (const m of text.matchAll(/`(\w+)\(\)`/g)) {
      const name = m[1];
      if (!/^[a-z]/.test(name)) continue;                                   // SQL keywords, constructors
      if (["npm", "node", "curl", "git", "docker", "openssl"].includes(name)) continue;   // shell, not ours
      claim(facts.exported.has(name) || facts.all.includes(`function ${name}`),
        `${doc} refers to ${name}(), which does not exist in src/ or tools/`);
    }
  }

  // A checker that extracts nothing reports success exactly like one that verified everything, and this project
  // has already produced a probe that reported a true and completely meaningless zero.
  assert.ok(checked >= 40, `only ${checked} claims were extracted — this test is not checking anything`);
  assert.deepEqual(problems, [], `${problems.length} documented claim(s) are not true:\n${problems.join("\n")}`);
});
