import { gzipSync } from "node:zlib";
import type { ValidatedConfig } from "./configuration.js";
import type { LogEvent, IngestRequest, FeedbackSubmission, FeedbackReceipt } from "./types.js";

const GZIP_THRESHOLD = 512;
const MAX_BATCH_SIZE = 20;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30000;
const MAX_RETRY_AFTER_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;

function extractServerError(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — return raw text.
  }
  return null;
}

/**
 * Parse a `Retry-After` value into milliseconds. Both forms RFC 9110 allows are
 * accepted — delta-seconds and an HTTP-date — and anything absent, empty or
 * unparsable yields null so the caller keeps its backoff ladder.
 */
function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * How long to wait before retrying `attempt`. The exponential ladder is the
 * floor; on a 429 or 503 a longer `Retry-After` from the server wins, and the
 * whole thing is capped so a hostile or mistaken header cannot stall a send.
 *
 * Exported for unit tests; not part of the package's public API.
 */
export function retryDelayMs(attempt: number, res?: Response, now: number = Date.now()): number {
  const backoff = Math.min(Math.pow(2, attempt) * 1000, MAX_BACKOFF_MS);
  if (!res || (res.status !== 429 && res.status !== 503)) return backoff;

  const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"), now);
  if (retryAfter === null) return backoff;

  return Math.min(Math.max(retryAfter, backoff), MAX_RETRY_AFTER_MS);
}

/**
 * Sleep before the next attempt, or return immediately when the attempt that
 * just failed was the last one. `res` is the response that failed, when there
 * was one — a network error has none.
 */
async function waitBeforeRetry(attempt: number, res?: Response): Promise<void> {
  if (attempt >= MAX_RETRIES) return;
  await new Promise((r) => setTimeout(r, retryDelayMs(attempt, res)));
}

export class Transport {
  private buffer: LogEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: ValidatedConfig;
  private inFlight: Promise<void> | null = null;

  constructor(config: ValidatedConfig) {
    this.config = config;
    this.timer = setInterval(() => this.flush().catch((err) => this.logError("flush failed", err)), config.flushIntervalMs);
    // Prevent timer from keeping the process alive
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  enqueue(event: LogEvent): void {
    if (this.buffer.length >= this.config.maxBufferSize) {
      // Drop oldest events
      this.buffer.shift();
    }
    this.buffer.push(event);

    if (this.buffer.length >= this.config.flushThreshold) {
      this.flush().catch((err) => this.logError("flush failed", err));
    }
  }

  /**
   * Drain the buffer. A caller arriving while a flush is already running waits
   * for it — including a send asleep in the retry ladder — and then sends
   * whatever was buffered meanwhile, so nothing is left behind.
   */
  async flush(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
    if (this.buffer.length === 0) return;

    // Published before the first await, so concurrent callers see it and wait
    // rather than starting a second drain.
    const run = this.drain().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    await run;
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
      await this.sendBatch(batch);
    }
  }

  private logError(message: string, err: unknown): void {
    if (this.config.debug) {
      console.error(`Pubky Pulse: ${message}`, err);
    }
  }

  async setUserProperties(userId: string, properties: Record<string, string>): Promise<void> {
    const body = JSON.stringify({ user_id: userId, properties });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(`${this.config.endpoint}/v1/identity/properties`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.config.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.ok) return;

        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          if (this.config.debug) {
            const text = await res.text().catch(() => "");
            console.error(`Pubky Pulse: setUserProperties failed with ${res.status}: ${text}`);
          }
          return;
        }
      } catch (err) {
        if (this.config.debug) {
          console.error("Pubky Pulse: network error during setUserProperties", err);
        }
      }

      await waitBeforeRetry(attempt, res);
    }

    if (this.config.debug) {
      console.error(`Pubky Pulse: setUserProperties failed after ${MAX_RETRIES + 1} attempts`);
    }
  }

  /**
   * Submit a feedback row synchronously. Returns the parsed receipt on success
   * or throws on terminal failure (4xx other than 429, or retries exhausted).
   *
   * Unlike `enqueue` and `setUserProperties`, this is developer-facing — the
   * caller is waiting on the result of a user action, so errors must propagate.
   */
  async submitFeedback(body: FeedbackSubmission): Promise<FeedbackReceipt> {
    const payload = JSON.stringify(body);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(`${this.config.endpoint}/v1/feedback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.config.apiKey}`,
          },
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.ok) {
          return (await res.json()) as FeedbackReceipt;
        }

        const text = await res.text().catch(() => "");

        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const serverMessage = extractServerError(text) ?? text;
          throw new Error(
            `Pubky Pulse: sendFeedback rejected (${res.status})${serverMessage ? `: ${serverMessage}` : ""}`,
          );
        }

        lastError = new Error(
          `Pubky Pulse: sendFeedback failed with ${res.status}${text ? `: ${text}` : ""}`,
        );
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Pubky Pulse: sendFeedback rejected")) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (this.config.debug) {
          console.error("Pubky Pulse: network error during sendFeedback", err);
        }
      }

      await waitBeforeRetry(attempt, res);
    }

    throw lastError ?? new Error("Pubky Pulse: sendFeedback failed after retries");
  }

  private async sendBatch(events: LogEvent[]): Promise<void> {
    try {
      const body: IngestRequest = { events };
      const json = JSON.stringify(body);

      let payload: Uint8Array | string;
      let contentEncoding: string | undefined;

      if (json.length > GZIP_THRESHOLD) {
        payload = new Uint8Array(gzipSync(json));
        contentEncoding = "gzip";
      } else {
        payload = json;
      }

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let res: Response | undefined;
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.config.apiKey}`,
          };
          if (contentEncoding) {
            headers["Content-Encoding"] = contentEncoding;
          }

          res = await fetch(`${this.config.endpoint}/v1/ingest`, {
            method: "POST",
            headers,
            body: payload as BodyInit,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

          if (res.ok) return;

          // Don't retry client errors (except 429)
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            if (this.config.debug) {
              const text = await res.text().catch(() => "");
              console.error(`Pubky Pulse: ingest failed with ${res.status}: ${text}`);
            }
            return;
          }
        } catch (err) {
          if (this.config.debug) {
            console.error("Pubky Pulse: network error during ingest", err);
          }
        }

        await waitBeforeRetry(attempt, res);
      }

      if (this.config.debug) {
        console.error(`Pubky Pulse: failed to send batch after ${MAX_RETRIES + 1} attempts, dropping ${events.length} events`);
      }
    } catch (err) {
      if (this.config.debug) {
        console.error("Pubky Pulse: failed to prepare batch for sending", err);
      }
    }
  }
}
