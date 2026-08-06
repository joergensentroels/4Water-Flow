// Does `node src/server.mjs` actually start a server? Nothing else in the suite can tell you: every other
// test imports buildApp() directly, so the entry-point guard is invisible to them.
//
// This exists because the guard was written as `import.meta.url === "file://" + argv[1]`, and on Windows an
// absolute path becomes file:///C:/... with THREE slashes. The comparison silently never matched, so running
// the server printed nothing and exited 0. A test that boots the real process is the only thing that fails
// on that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT } from "../src/config.mjs";

const PORT = 8123;
const DB = path.join(os.tmpdir(), `4water-boot-${process.pid}.db`);
const cleanup = () => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} } };

test("the entry point starts a listening server and reports the port", async () => {
  cleanup();
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    env: { ...process.env, FOURWATER_SECRET: "b".repeat(48), FOURWATER_DB: DB, PORT: String(PORT), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  try {
    // Poll rather than sleep-and-hope: a fixed sleep is either flaky or slow, and usually both.
    //
    // AND WAIT FOR THE CHILD'S OWN OUTPUT, not merely for the port to answer. This test binds a fixed port, and a
    // developer with the demo instance running on it — the command CONTRIBUTING prints uses 8123 — had `/healthz`
    // answered 200 by that OTHER process. The child was still starting, so the exit-code check passed too, and the
    // whole readiness probe was satisfied by somebody else's server. It failed one line later on the missing
    // "listening" message, which is luck: a foreign responder that happened to print a similar line would have made
    // this test pass while measuring a process it never started.
    //
    // So the child announcing itself is the readiness condition, and a port answering before that announcement is
    // reported as what it is rather than as a broken entry point.
    let status = 0;
    for (let i = 0; i < 50 && !/listening on/.test(out); i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) break;
      try { status = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).status; } catch {}
    }
    // No separate "somebody else is on this port" branch here, and that is deliberate. The first version of this fix
    // added one — and tools/deadassert.mjs reported it as never executed on the very next run, correctly: once the
    // cleanup below stopped hanging, a busy port makes the CHILD exit with EADDRINUSE, so the assertion two lines down
    // fires first and prints the child's own message, which names the cause better than anything written here could.
    // An unreachable branch that looks like a supported case is what rule 7 in CONTRIBUTING is about.
    assert.equal(child.exitCode, null, `the process exited early (code ${child.exitCode}) with output:\n${out}`);
    assert.equal(status, 200, `/healthz never answered. Process output was:\n${out || "(nothing at all — the classic symptom of a guard that never matched)"}`);
    assert.match(out, /listening on http:\/\/127\.0\.0\.1:8123/, "it should say where it is listening");
  } finally {
    // ONLY WAIT IF IT IS STILL RUNNING. `once("exit")` on a process that has ALREADY exited never fires — the event is
    // in the past — so this awaited forever in exactly the case worth reporting: the port was busy, the child died with
    // EADDRINUSE, and the test hung for two minutes instead of failing with the child's own error message. A hang is the
    // worst of the three outcomes, because it reads as a broken machine rather than a broken assumption, and it is the
    // second time this project has paid for cleanup written on the happy path — see test/nextdest.test.mjs, where a
    // failed assert leaked a listening socket and `node --test` never exited.
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
    cleanup();
  }
});

test("it refuses to start without a session secret, loudly", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    env: { ...process.env, FOURWATER_SECRET: "", FOURWATER_DB: path.join(os.tmpdir(), `4water-nosecret-${process.pid}.db`), PORT: "8124", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => child.once("exit", r));
  assert.notEqual(code, 0, "a missing secret must be a hard failure, not a default");
  assert.match(err, /FOURWATER_SECRET/, "and it must say which variable is missing");
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(path.join(os.tmpdir(), `4water-nosecret-${process.pid}.db${s}`)); } catch {} }
});

// A bad address is refused before the port opens, for the same reason a missing secret is: the value is pasted
// into every invite link, every calendar subscription and — since increment AI — every notification the whole
// department reads. Discovering it is wrong from a volunteer who cannot log in is the expensive way.
//
// Spawned rather than unit-tested on purpose. publicBaseUrl() throwing is easy to assert in isolation; what
// matters is that nothing on the way up catches it and carries on, which only the real process can show.
test("it refuses to start with a base URL that is not one", async () => {
  const db = path.join(os.tmpdir(), `4water-badurl-${process.pid}.db`);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    env: { ...process.env, FOURWATER_SECRET: "x".repeat(32), FOURWATER_BASE_URL: "plan-cph.4water.org",
           FOURWATER_DB: db, PORT: "8125", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => child.once("exit", r));
  assert.notEqual(code, 0, "a malformed address must be a hard failure, not a link nobody can follow");
  assert.match(err, /FOURWATER_BASE_URL/, "and it must say which variable is wrong");
  assert.match(err, /https?:\/\//, "and show the shape it wanted, since 'not a URL' is not actionable on its own");
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(db + s); } catch {} }
});

// The control for the test above: the SAME boot with a well-formed address must reach the point of listening.
// Without this, "refuses to start" would pass just as happily on a build that refuses to start at all.
test("and it starts normally when the base URL is a real one", async () => {
  const db = path.join(os.tmpdir(), `4water-goodurl-${process.pid}.db`);
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.mjs")], {
    env: { ...process.env, FOURWATER_SECRET: "x".repeat(32), FOURWATER_BASE_URL: "https://plan.example.org",
           FOURWATER_DB: db, PORT: "8126", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const listening = await new Promise((resolve) => {
    child.stdout.on("data", (d) => { out += d; if (/8126/.test(out)) resolve(true); });
    child.once("exit", () => resolve(false));
  });
  child.kill();
  assert.ok(listening, `a valid address must not stop the boot. Output was:\n${out}`);
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(db + s); } catch {} }
});
