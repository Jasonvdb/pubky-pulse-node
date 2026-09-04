import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Pulse, ScopedPulse } from "../../src/index.js";

describe("Pulse", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await Pulse.shutdown();
    globalThis.fetch = originalFetch;
  });

  function getCalls(): Array<{ url: string; init: RequestInit }> {
    const fn = globalThis.fetch as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } };
    return fn.mock.calls.map((c) => ({ url: c.arguments[0] as string, init: c.arguments[1] as RequestInit }));
  }

  function getCallCount(): number {
    const fn = globalThis.fetch as unknown as { mock: { callCount(): number } };
    return fn.mock.callCount();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseBody(init: RequestInit): any {
    const body = init.body;
    const headers = init.headers as Record<string, string>;
    if (headers?.["Content-Encoding"] === "gzip") {
      const decompressed = gunzipSync(Buffer.from(body as Uint8Array));
      return JSON.parse(decompressed.toString());
    }
    return JSON.parse(body as string);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function userEvents(body: any): any[] {
    // Strip SDK lifecycle events (sdk:session_started, sdk:session_ended)
    // so assertions can reason about the caller's events directly.
    return body.events.filter((e: { message?: string }) => !e.message?.startsWith("sdk:"));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findEventByMessage(message: string): any | undefined {
    for (const call of getCalls()) {
      const body = parseBody(call.init);
      const event = body.events.find((e: { message?: string }) => e.message === message);
      if (event) return event;
    }
    return undefined;
  }

  it("silently ignores logging before configure (never throws)", () => {
    // Pulse.info should not throw even when not configured
    assert.doesNotThrow(() => Pulse.info("hello"));
  });

  it("logs events at all levels after configure", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    Pulse.info("info msg");
    Pulse.debug("debug msg");
    Pulse.warn("warn msg");
    Pulse.error("error msg");
    Pulse.recordMetric("test-metric", { source: "test" });

    await Pulse.flush();

    assert.ok(getCallCount() > 0);

    const calls = getCalls();
    const body = parseBody(calls[0].init);
    const events = userEvents(body);
    assert.equal(events.length, 5);
    assert.equal(events[0].level, "info");
    assert.equal(events[0].message, "info msg");
    assert.equal(events[0].environment, "backend");
    assert.ok(events[0].session_id);
    assert.ok(events[0].client_event_id);
    assert.ok(events[0].timestamp);
  });

  it("withUser creates scoped logger with user_id", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    const pulse = Pulse.withUser("user_123");
    assert.ok(pulse instanceof ScopedPulse);

    pulse.info("user action", { key: "value" });
    await Pulse.flush();

    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].user_id, "user_123");
    assert.deepEqual(events[0].custom_attributes, { key: "value" });
  });

  it("truncates attribute values at 200 chars", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    const longValue = "x".repeat(300);
    Pulse.info("test", { long: longValue });
    await Pulse.flush();

    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].custom_attributes.long.length, 200);
  });

  it("truncates message at 2000 chars", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    const longMessage = "x".repeat(5000);
    Pulse.info(longMessage);
    await Pulse.flush();

    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].message.length, 2000);
    assert.equal(events[0].message, "x".repeat(2000));
  });

  it("coerces non-string attribute values to string", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    Pulse.info("test", { num: 42, bool: true, nil: null } as Record<string, unknown>);
    await Pulse.flush();

    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].custom_attributes.num, "42");
    assert.equal(events[0].custom_attributes.bool, "true");
    assert.equal(events[0].custom_attributes.nil, "null");
  });

  it("includes appVersion when configured", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      appVersion: "1.2.3",
      flushThreshold: 100,
    });

    Pulse.info("test");
    await Pulse.flush();

    const body = parseBody(getCalls()[0].init);
    assert.equal(body.events[0].app_version, "1.2.3");
  });

  it("stamps every event with sdk_name and sdk_version", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    Pulse.info("test");
    await Pulse.flush();

    const body = parseBody(getCalls()[0].init);
    assert.equal(body.events[0].sdk_name, "pubky-pulse-node");
    assert.match(body.events[0].sdk_version, /^\d+\.\d+\.\d+/);
  });

  it("does not include bundle_id in request body", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    Pulse.info("test");
    await Pulse.flush();

    const body = parseBody(getCalls()[0].init);
    assert.equal(body.bundle_id, undefined);
  });

  it("wrapHandler flushes after successful execution", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    const handler = Pulse.wrapHandler(async (name: string) => {
      Pulse.info("hello", { name });
      return `hi ${name}`;
    });

    const result = await handler("world");
    assert.equal(result, "hi world");
    assert.ok(getCallCount() > 0);
  });

  it("wrapHandler flushes when handler throws", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    const handler = Pulse.wrapHandler(async () => {
      Pulse.error("something broke");
      throw new Error("boom");
    });

    await assert.rejects(handler, { message: "boom" });
    assert.ok(getCallCount() > 0);
  });

  it("wrapHandler preserves arguments", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });

    let receivedArgs: unknown[] = [];
    const handler = Pulse.wrapHandler(async (a: number, b: string, c: boolean) => {
      receivedArgs = [a, b, c];
    });

    await handler(42, "test", true);
    assert.deepEqual(receivedArgs, [42, "test", true]);
  });

  it("wrapHandler works when not configured", async () => {
    // Don't call configure — handler should still work without throwing
    const handler = Pulse.wrapHandler(async () => "ok");
    const result = await handler();
    assert.equal(result, "ok");
  });

  it("generates new session_id on each configure", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("first");
    await Pulse.flush();

    await Pulse.shutdown();

    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("second");
    await Pulse.flush();

    const firstEvent = findEventByMessage("first");
    const secondEvent = findEventByMessage("second");
    assert.ok(firstEvent, "first event not found in any call");
    assert.ok(secondEvent, "second event not found in any call");
    assert.notEqual(firstEvent.session_id, secondEvent.session_id);
  });

  it("does not emit sdk:session_started when configure() is called but no events are tracked", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    await Pulse.flush();
    assert.equal(getCallCount(), 0);
  });

  it("emits sdk:session_started immediately before the first user event", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("hello");
    await Pulse.flush();

    const body = parseBody(getCalls()[0].init);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0].message, "sdk:session_started");
    assert.equal(body.events[1].message, "hello");
  });

  it("emits sdk:session_started exactly once across multiple user events", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("first");
    Pulse.info("second");
    Pulse.info("third");
    await Pulse.flush();

    const body = parseBody(getCalls()[0].init);
    const starts = body.events.filter((e: { message?: string }) => e.message === "sdk:session_started");
    assert.equal(starts.length, 1);
    assert.equal(body.events[0].message, "sdk:session_started");
  });

  it("does not emit sdk:session_ended on shutdown when no user events were tracked", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    await Pulse.shutdown();
    assert.equal(getCallCount(), 0);
  });

  it("emits sdk:session_ended on shutdown when user events were tracked", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("hello");
    await Pulse.shutdown();

    assert.ok(findEventByMessage("sdk:session_started"));
    assert.ok(findEventByMessage("hello"));
    assert.ok(findEventByMessage("sdk:session_ended"));
  });

  it("resets the session_started gate across configure cycles", async () => {
    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("first");
    await Pulse.shutdown();

    Pulse.configure({
      endpoint: "http://localhost:4000",
      apiKey: "pulse_client_test_1234567890123456789012345678",
      flushThreshold: 100,
    });
    Pulse.info("second");
    await Pulse.flush();

    const starts: Array<{ session_id: string }> = [];
    for (const call of getCalls()) {
      const body = parseBody(call.init);
      for (const e of body.events) {
        if (e.message === "sdk:session_started") starts.push(e);
      }
    }
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].session_id, starts[1].session_id);
  });
});
