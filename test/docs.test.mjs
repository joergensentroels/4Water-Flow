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
