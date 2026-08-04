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
    let status = 0;
    for (let i = 0; i < 50 && status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) break;
      try { status = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).status; } catch {}
    }
    assert.equal(child.exitCode, null, `the process exited early (code ${child.exitCode}) with output:\n${out}`);
    assert.equal(status, 200, `/healthz never answered. Process output was:\n${out || "(nothing at all — the classic symptom of a guard that never matched)"}`);
    assert.match(out, /listening on http:\/\/127\.0\.0\.1:8123/, "it should say where it is listening");
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
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
