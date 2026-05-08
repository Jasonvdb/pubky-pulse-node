import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Path to the built CJS bundle. The test suite is gated on `npm run build`
// having run first (in the `test` npm script via build:tests, but we need
// the SDK bundle which is built by `npm run build`). Resolve dynamically.
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const SDK_PATH = join(here, "..", "..", "..", "dist", "index.cjs");

function writeChild(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "owlmetry-autocap-"));
  const file = join(dir, "child.cjs");
  writeFileSync(file, content);
  return file;
}

function runChild(content: string): { status: number | null; stdout: string; stderr: string } {
  const file = writeChild(content);
  const r = spawnSync(process.execPath, [file], {
    encoding: "utf-8",
    timeout: 10000,
    env: { ...process.env, OWLMETRY_TEST_AUTOCAP: "1" },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("auto-capture preserves crash semantics in child processes", () => {
  it("crashing app loaded with the SDK still exits non-zero on uncaughtException", () => {
    // Sanity baseline: a process that throws asynchronously, with the SDK
    // loaded + captureUnhandled default-on, must still exit with a non-zero
    // code. If the SDK accidentally swallowed the crash (by being the only
    // listener and not calling process.exit(1)), exit code would be 0.
    const r = runChild(`
      const { Owl } = require(${JSON.stringify(SDK_PATH)});
      Owl.configure({
        endpoint: "http://127.0.0.1:1",
        apiKey: "owl_client_test_1234567890123456789012345678",
        consoleLogging: false,
      });
      setImmediate(() => { throw new Error("boom"); });
    `);
    assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}, stderr=${r.stderr}`);
  });

  it("user-provided uncaughtException handler still wins (exit code 2)", () => {
    // The user attaches their own handler that calls process.exit(2).
    // The SDK must observe the error but NOT override the user's exit code.
    const r = runChild(`
      const { Owl } = require(${JSON.stringify(SDK_PATH)});
      Owl.configure({
        endpoint: "http://127.0.0.1:1",
        apiKey: "owl_client_test_1234567890123456789012345678",
        consoleLogging: false,
      });
      process.on("uncaughtException", () => process.exit(2));
      setImmediate(() => { throw new Error("user-controlled"); });
    `);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}, stderr=${r.stderr}`);
  });

  it("captureUnhandled:false leaves Node's default crash behavior untouched", () => {
    // No SDK listeners → Node default crash. Exit non-zero, just like
    // running without the SDK.
    const r = runChild(`
      const { Owl } = require(${JSON.stringify(SDK_PATH)});
      Owl.configure({
        endpoint: "http://127.0.0.1:1",
        apiKey: "owl_client_test_1234567890123456789012345678",
        consoleLogging: false,
        captureUnhandled: false,
      });
      setImmediate(() => { throw new Error("opt-out"); });
    `);
    assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}, stderr=${r.stderr}`);
  });

  it("unhandled promise rejection still crashes when SDK is the only listener", () => {
    // Node 15+ default --unhandled-rejections=throw must still escalate to
    // a process crash even with our handler attached. We achieve this by
    // re-throwing from our rejectionHandler when listenerCount <= 1.
    const r = runChild(`
      const { Owl } = require(${JSON.stringify(SDK_PATH)});
      Owl.configure({
        endpoint: "http://127.0.0.1:1",
        apiKey: "owl_client_test_1234567890123456789012345678",
        consoleLogging: false,
      });
      Promise.reject(new Error("unhandled"));
      // Keep the loop alive briefly so the rejection has time to fire.
      setTimeout(() => {}, 1000);
    `);
    assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}, stderr=${r.stderr}`);
  });
});
