import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Owl } from "../../src/index.js";

describe("Owl auto-capture handler registration", () => {
  const originalFetch = globalThis.fetch;
  let baselineUncaught = 0;
  let baselineRejection = 0;

  beforeEach(() => {
    baselineUncaught = process.listenerCount("uncaughtException");
    baselineRejection = process.listenerCount("unhandledRejection");
    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await Owl.shutdown();
    globalThis.fetch = originalFetch;
    // Sanity: shutdown must restore the baseline.
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught);
    assert.equal(process.listenerCount("unhandledRejection"), baselineRejection);
  });

  it("default-on registers both listeners on configure", () => {
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
    });
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught + 1);
    assert.equal(process.listenerCount("unhandledRejection"), baselineRejection + 1);
  });

  it("captureUnhandled:false does NOT register listeners", () => {
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
      captureUnhandled: false,
    });
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught);
    assert.equal(process.listenerCount("unhandledRejection"), baselineRejection);
  });

  it("re-configuring with different captureUnhandled flips registration", () => {
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
      captureUnhandled: true,
    });
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught + 1);

    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
      captureUnhandled: false,
    });
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught);
  });

  it("calling configure twice with default-on does not double-register", () => {
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
    });
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
    });
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught + 1);
    assert.equal(process.listenerCount("unhandledRejection"), baselineRejection + 1);
  });

  it("shutdown removes both listeners cleanly", async () => {
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
    });
    await Owl.shutdown();
    assert.equal(process.listenerCount("uncaughtException"), baselineUncaught);
    assert.equal(process.listenerCount("unhandledRejection"), baselineRejection);
  });

  it("captures an uncaught exception into the event stream when invoked directly", async () => {
    // We cannot trigger a real uncaughtException from inside a test (Node's
    // test runner has its own handler), but we can verify the listener does
    // the right thing by extracting it from `process` and calling it.
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    const listeners = process.listeners("uncaughtException");
    assert.ok(listeners.length >= 1, "expected at least one uncaughtException listener");
    // Our listener is the most recently added one.
    const ourListener = listeners[listeners.length - 1] as (err: unknown) => void;

    const before = (globalThis.fetch as unknown as { mock: { callCount(): number } }).mock.callCount();
    // Pretend uncaughtException fires. We expect: capture, then async flush.
    // Because there's also the test-runner's listener, our listener won't
    // call process.exit(1) (listenerCount > 1).
    ourListener(new TypeError("simulated uncaught"));
    // Wait a tick so the async flush + enqueue completes.
    await new Promise((r) => setTimeout(r, 50));
    await Owl.flush();
    const after = (globalThis.fetch as unknown as { mock: { callCount(): number } }).mock.callCount();
    assert.ok(after > before, "expected an event to be sent after the simulated crash");
  });
});
