import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractErrorAttributes } from "../../src/error-extraction.js";

describe("extractErrorAttributes", () => {
  it("extracts type, stack, and message from a plain Error", () => {
    const err = new Error("boom");
    const result = extractErrorAttributes(err);
    assert.equal(result.message, "boom");
    assert.equal(result.attributes._error_type, "Error");
    assert.ok(result.attributes._error_stack && result.attributes._error_stack.length > 0);
    assert.ok(result.attributes._error_stack!.includes("boom"));
  });

  it("uses error.name for subclasses (TypeError, RangeError, custom)", () => {
    class CustomBoom extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomBoom";
      }
    }
    const t = extractErrorAttributes(new TypeError("nope"));
    assert.equal(t.attributes._error_type, "TypeError");
    const r = extractErrorAttributes(new RangeError("oob"));
    assert.equal(r.attributes._error_type, "RangeError");
    const c = extractErrorAttributes(new CustomBoom("kaboom"));
    assert.equal(c.attributes._error_type, "CustomBoom");
  });

  it("walks Error.cause chains up to 5 levels", () => {
    const inner = new Error("level3");
    const middle = new Error("level2", { cause: inner });
    const outer = new Error("level1", { cause: middle });
    const result = extractErrorAttributes(outer);
    assert.equal(result.attributes._error_cause_1_message, "level2");
    assert.equal(result.attributes._error_cause_2_message, "level3");
    assert.equal(result.attributes._error_cause_3_type, undefined);
  });

  it("stops cause walk at depth 5", () => {
    let chain = new Error("level7");
    for (let i = 6; i >= 1; i--) {
      chain = new Error(`level${i}`, { cause: chain });
    }
    const result = extractErrorAttributes(chain);
    assert.ok(result.attributes._error_cause_5_message);
    assert.equal(result.attributes._error_cause_6_message, undefined);
  });

  it("breaks cause cycles without infinite loop", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    const result = extractErrorAttributes(a);
    // Should not hang and should not exceed depth 5.
    assert.ok(result.attributes._error_cause_1_message);
    assert.equal(result.attributes._error_cause_5_message, undefined);
  });

  it("surfaces NodeJS.ErrnoException fields (code/syscall/path)", () => {
    const err = Object.assign(new Error("ENOENT, open '/foo'"), {
      code: "ENOENT",
      errno: -2,
      syscall: "open",
      path: "/foo",
    });
    const result = extractErrorAttributes(err);
    assert.equal(result.attributes._error_code, "ENOENT");
    assert.equal(result.attributes._error_errno, "-2");
    assert.equal(result.attributes._error_syscall, "open");
    assert.equal(result.attributes._error_path, "/foo");
  });

  it("surfaces AggregateError children count + first error", () => {
    const agg = new AggregateError(
      [new TypeError("first"), new Error("second")],
      "multiple failures",
    );
    const result = extractErrorAttributes(agg);
    assert.equal(result.attributes._error_aggregate_count, "2");
    assert.equal(result.attributes._error_aggregate_first_type, "TypeError");
    assert.equal(result.attributes._error_aggregate_first_message, "first");
  });

  it("handles thrown strings without crashing", () => {
    const result = extractErrorAttributes("just a string");
    assert.equal(result.attributes._error_type, "string");
    assert.equal(result.message, "just a string");
  });

  it("handles thrown numbers without crashing", () => {
    const result = extractErrorAttributes(42);
    assert.equal(result.attributes._error_type, "number");
    assert.equal(result.message, "42");
  });

  it("handles null and undefined", () => {
    const n = extractErrorAttributes(null);
    assert.equal(n.attributes._error_type, "null");
    assert.equal(n.message, "null");
    const u = extractErrorAttributes(undefined);
    assert.equal(u.attributes._error_type, "undefined");
    assert.equal(u.message, "undefined");
  });

  it("user-provided message wins over error.message", () => {
    const err = new Error("internal detail");
    const result = extractErrorAttributes(err, "while loading photos");
    assert.equal(result.message, "while loading photos");
    // The original error.message is no longer in event.message but the
    // stack still carries it for context.
    assert.ok(result.attributes._error_stack!.includes("internal detail"));
  });

  it("empty/whitespace user message falls through to error.message", () => {
    const err = new Error("from error");
    const r1 = extractErrorAttributes(err, "");
    const r2 = extractErrorAttributes(err, "   ");
    assert.equal(r1.message, "from error");
    assert.equal(r2.message, "from error");
  });

  it("truncates stack at 16000 chars", () => {
    const err = new Error("x");
    err.stack = "x".repeat(20000);
    const result = extractErrorAttributes(err);
    assert.equal(result.attributes._error_stack!.length, 16000);
  });
});
