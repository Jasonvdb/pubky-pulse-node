import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Pulse } from "../../src/index.js";
import { Transport } from "../../src/transport.js";
import type { ValidatedConfig } from "../../src/configuration.js";
import { SDK_NAME } from "../../src/types.js";

// These assertions pin the user-visible Pubky Pulse branding: the console
// prefix, the "Pubky Pulse: " message prefix, and the wire-level sdk_name.
// They exist so a partial rename cannot pass unnoticed.
describe("Pubky Pulse branding", () => {
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    await Pulse.shutdown();
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it("reports the pubky-pulse-node SDK name", () => {
    assert.equal(SDK_NAME, "pubky-pulse-node");
  });

  it("prefixes console output with [pulse]", () => {
    const logged: string[] = [];
    mock.method(console, "log", (line: string) => {
      logged.push(line);
    });

    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
    }) as unknown as typeof fetch;

    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      consoleLogging: true,
      captureUnhandled: false,
    });
    Pulse.info("branded message");

    assert.ok(
      logged.some((line) => line.startsWith("[pulse] ") && line.includes("branded message")),
      `expected a "[pulse] " prefixed line, got ${JSON.stringify(logged)}`,
    );
  });

  it("rejects unconfigured sendFeedback with the Pubky Pulse message", async () => {
    await assert.rejects(
      () => Pulse.sendFeedback("hello"),
      /^Error: Pubky Pulse: not configured\. Call Pulse\.configure\(\) first\.$/,
    );
  });

  it("treats a 4xx feedback rejection as terminal via the Pubky Pulse prefix", async () => {
    // src/transport.ts throws "Pubky Pulse: sendFeedback rejected (...)" and
    // re-throws it by matching that exact prefix — the two must stay in sync,
    // otherwise a 4xx would be retried instead of surfacing immediately.
    const config: ValidatedConfig = {
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      serviceName: "test",
      debug: false,
      isDev: true,
      flushIntervalMs: 60000,
      flushThreshold: 5,
      maxBufferSize: 100,
      consoleLogging: false,
      captureUnhandled: false,
    };

    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    }) as unknown as typeof fetch;

    const transport = new Transport(config);
    try {
      await assert.rejects(
        () => transport.submitFeedback({ message: "hi" }),
        /^Error: Pubky Pulse: sendFeedback rejected \(400\)/,
      );

      const fn = globalThis.fetch as unknown as { mock: { callCount(): number } };
      assert.equal(fn.mock.callCount(), 1, "a 4xx rejection must not be retried");
    } finally {
      await transport.shutdown();
    }
  });
});
