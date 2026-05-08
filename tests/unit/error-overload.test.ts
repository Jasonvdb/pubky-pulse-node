import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Owl } from "../../src/index.js";

describe("Owl.error overload accepting Error values", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await Owl.shutdown();
    globalThis.fetch = originalFetch;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getCalls(): Array<{ url: string; init: RequestInit }> {
    const fn = globalThis.fetch as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } };
    return fn.mock.calls.map((c) => ({ url: c.arguments[0] as string, init: c.arguments[1] as RequestInit }));
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
    return body.events.filter((e: { message?: string }) => !e.message?.startsWith("sdk:"));
  }

  function configure(): void {
    Owl.configure({
      endpoint: "http://localhost:4000",
      apiKey: "owl_client_test_1234567890123456789012345678",
      flushThreshold: 100,
      captureUnhandled: false, // off in tests so listeners don't outlive the test
    });
  }

  it("string-message form keeps existing behavior", async () => {
    configure();
    Owl.error("plain string");
    await Owl.flush();
    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events.length, 1);
    assert.equal(events[0].message, "plain string");
    assert.equal(events[0].custom_attributes, undefined);
  });

  it("Error-value form extracts type/stack into custom_attributes", async () => {
    configure();
    Owl.error(new TypeError("oops"));
    await Owl.flush();
    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events.length, 1);
    assert.equal(events[0].message, "oops");
    assert.equal(events[0].custom_attributes._error_type, "TypeError");
    assert.ok(events[0].custom_attributes._error_stack);
  });

  it("Error-value form with caller message uses caller message", async () => {
    configure();
    Owl.error(new Error("internal"), "while saving order");
    await Owl.flush();
    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].message, "while saving order");
    // _error_stack still carries the original error context
    assert.ok(events[0].custom_attributes._error_stack.includes("internal"));
  });

  it("Error-value form merges caller-provided attrs (caller keys preserved)", async () => {
    configure();
    Owl.error(new Error("boom"), undefined, { request_id: "req-1" });
    await Owl.flush();
    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].custom_attributes.request_id, "req-1");
    assert.equal(events[0].custom_attributes._error_type, "Error");
  });

  it("Error-value form preserves _error_stack length above the 200-char cap", async () => {
    configure();
    const err = new Error("boom");
    err.stack = "x".repeat(8000);
    Owl.error(err);
    await Owl.flush();
    const events = userEvents(parseBody(getCalls()[0].init));
    assert.equal(events[0].custom_attributes._error_stack.length, 8000);
  });

  it("Error-value form handles thrown non-Error values", async () => {
    configure();
    Owl.error("string-thrown");
    Owl.error(42 as unknown as Error);
    Owl.error(null);
    await Owl.flush();
    const events = userEvents(parseBody(getCalls()[0].init));
    // First event: matches the string overload (message is the string)
    assert.equal(events[0].message, "string-thrown");
    // Second: number passed as Error overload
    assert.equal(events[1].message, "42");
    assert.equal(events[1].custom_attributes._error_type, "number");
    // Third: null
    assert.equal(events[2].message, "null");
    assert.equal(events[2].custom_attributes._error_type, "null");
  });
});
