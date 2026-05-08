/**
 * Extract structured fields from a value passed to `Owl.error(error)` for
 * delivery as `_error_*` reserved custom attributes. The server reads these
 * to drive issue fingerprinting (`_error_type` is the discriminator) and
 * dashboard rendering.
 *
 * Accepts `unknown` because JS allows `throw <anything>` — primitives, plain
 * objects, etc. all flow through to a sensible result.
 */

const MAX_CAUSE_DEPTH = 5;
const MAX_STACK_LENGTH = 16000;
const MAX_VALUE_LENGTH = 200; // matches MAX_CUSTOM_ATTRIBUTE_VALUE_LENGTH

export interface ExtractionResult {
  message: string;
  attributes: Record<string, string>;
}

/**
 * Build the event message + reserved `_error_*` attributes for an error
 * value. Caller-provided `userMessage` wins; otherwise we derive from
 * `error.message` / `String(error)`.
 */
export function extractErrorAttributes(
  error: unknown,
  userMessage?: string,
): ExtractionResult {
  const attrs: Record<string, string> = {};

  if (error instanceof Error) {
    attrs._error_type = error.name || error.constructor.name || "Error";
    if (typeof error.stack === "string" && error.stack.length > 0) {
      attrs._error_stack =
        error.stack.length > MAX_STACK_LENGTH
          ? error.stack.slice(0, MAX_STACK_LENGTH)
          : error.stack;
    }
    extractNodeErrnoFields(error, attrs);
    extractAggregateErrors(error, attrs);
    walkCauseChain(error, attrs);
  } else {
    // throw "boom" / throw 42 / throw { foo: "bar" }
    attrs._error_type = error === null ? "null" : typeof error;
  }

  const message = resolveMessage(error, userMessage);
  return { message, attributes: attrs };
}

function resolveMessage(error: unknown, userMessage?: string): string {
  if (typeof userMessage === "string") {
    const trimmed = userMessage.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  if (typeof error === "string") return error;
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  try {
    return String(error);
  } catch {
    return "<unrepresentable error>";
  }
}

function clip(value: string, max = MAX_VALUE_LENGTH): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Surface NodeJS.ErrnoException fields when present (FS / network errors
 * commonly carry these): code, errno, syscall, path. Anything missing is
 * silently skipped.
 */
function extractNodeErrnoFields(error: Error, attrs: Record<string, string>): void {
  const errno = error as NodeJS.ErrnoException;
  const codeUnknown = (error as unknown as { code?: unknown }).code;
  if (typeof errno.code === "string" && errno.code.length > 0) {
    attrs._error_code = clip(errno.code);
  } else if (typeof codeUnknown === "number") {
    attrs._error_code = String(codeUnknown);
  }
  if (typeof errno.errno === "number") {
    attrs._error_errno = String(errno.errno);
  }
  if (typeof errno.syscall === "string" && errno.syscall.length > 0) {
    attrs._error_syscall = clip(errno.syscall);
  }
  if (typeof errno.path === "string" && errno.path.length > 0) {
    attrs._error_path = clip(errno.path);
  }
}

/**
 * AggregateError carries an `errors` array. Surface the count and the first
 * error's type/message so the dashboard isn't blind to multi-error rejects.
 */
function extractAggregateErrors(error: Error, attrs: Record<string, string>): void {
  const agg = error as Error & { errors?: unknown };
  if (!Array.isArray(agg.errors)) return;
  attrs._error_aggregate_count = String(agg.errors.length);
  const first = agg.errors[0];
  if (first instanceof Error) {
    attrs._error_aggregate_first_type = clip(first.name || "Error");
    attrs._error_aggregate_first_message = clip(first.message || String(first));
  } else if (first !== undefined) {
    attrs._error_aggregate_first_type = clip(typeof first);
    attrs._error_aggregate_first_message = clip(String(first));
  }
}

/**
 * Walk `Error.cause` up to MAX_CAUSE_DEPTH levels, surfacing each cause's
 * type and message. Cycle-safe via a Set of seen objects.
 */
function walkCauseChain(error: Error, attrs: Record<string, string>): void {
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as Error & { cause?: unknown }).cause;
  let depth = 1;
  while (current !== undefined && current !== null && depth <= MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      attrs[`_error_cause_${depth}_type`] = clip(current.name || current.constructor.name || "Error");
      attrs[`_error_cause_${depth}_message`] = clip(current.message || String(current));
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      attrs[`_error_cause_${depth}_type`] = clip(typeof current);
      attrs[`_error_cause_${depth}_message`] = clip(String(current));
      break; // non-Error cause has no further chain
    }
    depth += 1;
  }
}
