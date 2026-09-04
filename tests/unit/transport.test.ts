import { describe, it, afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Transport, retryDelayMs } from "../../src/transport.js";
import type { ValidatedConfig } from "../../src/configuration.js";
import type { LogEvent } from "../../src/types.js";

function makeConfig(overrides?: Partial<ValidatedConfig>): ValidatedConfig {
  return {
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
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<LogEvent>): LogEvent {
  return {
    client_event_id: "evt-1",
    session_id: "sess-1",
    level: "info",
    message: "test event",
    environment: "backend",
    sdk_name: "pubky-pulse-node",
    sdk_version: "0.0.0-test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
}

/** Resolve once pending microtasks and I/O callbacks have run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeTimers {
  /** Every delay the code under test asked to sleep for, in order. */
  delays: number[];
  /** Run the sleeps queued so far (manual mode only). */
  fire(): void;
  restore(): void;
}

/**
 * Replace `setTimeout` so the retry ladder can be observed without waiting it
 * out. In the default automatic mode each sleep completes immediately; in
 * manual mode it stays pending until `fire()`.
 */
function installFakeTimers(options: { auto?: boolean } = {}): FakeTimers {
  const auto = options.auto ?? true;
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  const pending: Array<() => void> = [];

  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    if (auto) return original(callback, 0);
    pending.push(callback);
    return original(() => {}, 0);
  }) as unknown as typeof setTimeout;

  return {
    delays,
    fire() {
      for (const callback of pending.splice(0, pending.length)) callback();
    },
    restore() {
      globalThis.setTimeout = original;
    },
  };
}

/** The event IDs of one ingest request, transparently gunzipping if needed. */
function sentEventIds(init: RequestInit): string[] {
  const body = init.body as string | Uint8Array;
  const json = typeof body === "string" ? body : gunzipSync(body).toString("utf8");
  const parsed = JSON.parse(json) as { events: LogEvent[] };
  return parsed.events.map((event) => event.client_event_id);
}

describe("Transport", () => {
  let transport: Transport;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Keep the shutdown in afterEach off the network — an unreachable endpoint
    // would sit through the whole retry ladder.
    globalThis.fetch = mock.fn(async () => okResponse()) as unknown as typeof fetch;
  });

  afterEach(async () => {
    if (transport) await transport.shutdown();
    globalThis.fetch = originalFetch;
  });

  it("buffers events", () => {
    transport = new Transport(makeConfig());
    transport.enqueue(makeEvent());
    transport.enqueue(makeEvent({ client_event_id: "evt-2" }));
    assert.equal(transport.bufferSize, 2);
  });

  it("drops oldest when buffer exceeds maxBufferSize", () => {
    transport = new Transport(makeConfig({ maxBufferSize: 3, flushThreshold: 100 }));

    transport.enqueue(makeEvent({ client_event_id: "evt-1" }));
    transport.enqueue(makeEvent({ client_event_id: "evt-2" }));
    transport.enqueue(makeEvent({ client_event_id: "evt-3" }));
    transport.enqueue(makeEvent({ client_event_id: "evt-4" }));

    assert.equal(transport.bufferSize, 3);
  });

  it("clears buffer on shutdown", async () => {
    transport = new Transport(makeConfig());
    transport.enqueue(makeEvent());
    await transport.shutdown();

    assert.equal(transport.bufferSize, 0);
    const fn = globalThis.fetch as unknown as { mock: { callCount(): number } };
    assert.ok(fn.mock.callCount() > 0, "should have called fetch");
  });

  it("clears timer on shutdown", async () => {
    transport = new Transport(makeConfig());
    await transport.shutdown();
    // Verify no error when shutting down again
    await transport.shutdown();
  });
});

describe("retryDelayMs", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");

  function response(status: number, retryAfter?: string): Response {
    return new Response(null, {
      status,
      headers: retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
    });
  }

  it("follows the exponential ladder without a response", () => {
    assert.equal(retryDelayMs(0), 1000);
    assert.equal(retryDelayMs(3), 8000);
    assert.equal(retryDelayMs(4), 16000);
    // Capped at the maximum backoff.
    assert.equal(retryDelayMs(5), 30000);
    assert.equal(retryDelayMs(9), 30000);
  });

  it("keeps the ladder when the response carries no Retry-After", () => {
    assert.equal(retryDelayMs(0, response(429), now), 1000);
    assert.equal(retryDelayMs(2, response(503), now), 4000);
  });

  it("waits out delta-seconds Retry-After on 429 and 503", () => {
    assert.equal(retryDelayMs(0, response(429, "7"), now), 7000);
    assert.equal(retryDelayMs(0, response(503, "7"), now), 7000);
  });

  it("never waits less than the ladder", () => {
    assert.equal(retryDelayMs(3, response(429, "1"), now), 8000);
  });

  it("honors an HTTP-date Retry-After", () => {
    assert.equal(retryDelayMs(0, response(429, "Fri, 04 Sep 2026 12:00:09 GMT"), now), 9000);
  });

  it("treats an HTTP-date in the past as no wait, so the ladder applies", () => {
    assert.equal(retryDelayMs(1, response(429, "Fri, 04 Sep 2026 11:59:00 GMT"), now), 2000);
  });

  it("caps an excessive Retry-After", () => {
    assert.equal(retryDelayMs(0, response(503, "600"), now), 60000);
    assert.equal(retryDelayMs(0, response(429, "Fri, 04 Sep 2026 13:00:00 GMT"), now), 60000);
  });

  it("falls back to the ladder for an unparsable Retry-After", () => {
    assert.equal(retryDelayMs(1, response(429, "soon"), now), 2000);
    assert.equal(retryDelayMs(1, response(429, ""), now), 2000);
    // A bare "-5" is not delta-seconds; whatever Date.parse makes of it lands in
    // the past, so it never shortens the wait either.
    assert.equal(retryDelayMs(1, response(429, "-5"), now), 2000);
  });

  it("ignores Retry-After on statuses that do not define it", () => {
    assert.equal(retryDelayMs(0, response(500, "30"), now), 1000);
    assert.equal(retryDelayMs(0, response(502, "30"), now), 1000);
  });
});

describe("Transport retries", () => {
  let transport: Transport;
  const originalFetch = globalThis.fetch;
  let timers: FakeTimers | null = null;

  afterEach(async () => {
    timers?.restore();
    timers = null;
    if (transport) await transport.shutdown();
    globalThis.fetch = originalFetch;
  });

  it("waits the server's Retry-After before retrying an ingest batch", async () => {
    timers = installFakeTimers();
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "7" } });
      }
      return okResponse();
    }) as unknown as typeof fetch;

    transport = new Transport(makeConfig());
    transport.enqueue(makeEvent());
    await transport.flush();

    assert.equal(calls, 2);
    assert.deepEqual(timers.delays, [7000]);
    assert.equal(transport.bufferSize, 0);
  });

  it("keeps the backoff ladder when the server sends no Retry-After", async () => {
    timers = installFakeTimers();
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls <= 2) return new Response("", { status: 500 });
      return okResponse();
    }) as unknown as typeof fetch;

    transport = new Transport(makeConfig());
    transport.enqueue(makeEvent());
    await transport.flush();

    assert.equal(calls, 3);
    assert.deepEqual(timers.delays, [1000, 2000]);
  });

  it("waits the server's Retry-After before retrying setUserProperties", async () => {
    timers = installFakeTimers();
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 503, headers: { "Retry-After": "12" } });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    transport = new Transport(makeConfig());
    await transport.setUserProperties("user_1", { plan: "pro" });

    assert.equal(calls, 2);
    assert.deepEqual(timers.delays, [12000]);
  });

  it("waits the server's Retry-After before retrying feedback", async () => {
    timers = installFakeTimers();
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "9" } });
      }
      return new Response(JSON.stringify({ id: "fb_1", created_at: "2026-09-04T12:00:00Z" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    transport = new Transport(makeConfig());
    const receipt = await transport.submitFeedback({ message: "hi" });

    assert.equal(receipt.id, "fb_1");
    assert.equal(calls, 2);
    assert.deepEqual(timers.delays, [9000]);
  });

  it("does not sleep after the final attempt", async () => {
    timers = installFakeTimers();
    globalThis.fetch = mock.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;

    transport = new Transport(makeConfig());
    transport.enqueue(makeEvent());
    await transport.flush();

    // Six attempts, so five sleeps — none after the last failure.
    assert.deepEqual(timers.delays, [1000, 2000, 4000, 8000, 16000]);
  });
});

describe("Transport shutdown", () => {
  let transport: Transport;
  const originalFetch = globalThis.fetch;
  let timers: FakeTimers | null = null;

  afterEach(async () => {
    timers?.restore();
    timers = null;
    if (transport) await transport.shutdown();
    globalThis.fetch = originalFetch;
  });

  it("waits for a send already in flight, then drains what arrived meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[][] = [];

    globalThis.fetch = mock.fn(async (_url: string, init: RequestInit) => {
      sent.push(sentEventIds(init));
      if (sent.length === 1) await gate;
      return okResponse();
    }) as unknown as typeof fetch;

    transport = new Transport(makeConfig({ flushThreshold: 2 }));
    transport.enqueue(makeEvent({ client_event_id: "evt-1" }));
    transport.enqueue(makeEvent({ client_event_id: "evt-2" }));
    await tick();
    assert.equal(sent.length, 1, "the threshold flush should be in flight");

    // Buffered while that send is still open — it must not be lost.
    transport.enqueue(makeEvent({ client_event_id: "evt-3" }));

    let settled = false;
    const done = transport.shutdown().then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false, "shutdown must not resolve while a send is in flight");

    release();
    await done;

    assert.deepEqual(sent, [["evt-1", "evt-2"], ["evt-3"]]);
    assert.equal(transport.bufferSize, 0);
  });

  it("waits for a send sleeping in the retry ladder", async () => {
    timers = installFakeTimers({ auto: false });
    let calls = 0;
    globalThis.fetch = mock.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 503, headers: { "Retry-After": "2" } });
      }
      return okResponse();
    }) as unknown as typeof fetch;

    transport = new Transport(makeConfig({ flushThreshold: 1 }));
    transport.enqueue(makeEvent());
    await tick();
    assert.equal(calls, 1);
    assert.deepEqual(timers.delays, [2000], "should be sleeping out the Retry-After");

    let settled = false;
    const done = transport.shutdown().then(() => {
      settled = true;
    });
    await tick();
    assert.equal(settled, false, "shutdown must not resolve while a retry is sleeping");

    timers.fire();
    await done;

    assert.equal(calls, 2);
    assert.equal(transport.bufferSize, 0);
  });

  it("stops the flush timer", async () => {
    const fetchMock = mock.fn(async () => okResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    transport = new Transport(makeConfig({ flushIntervalMs: 5, flushThreshold: 100 }));
    await transport.shutdown();

    transport.enqueue(makeEvent());
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(fetchMock.mock.callCount(), 0, "the timer must not fire after shutdown");
    assert.equal(transport.bufferSize, 1);
  });
});
