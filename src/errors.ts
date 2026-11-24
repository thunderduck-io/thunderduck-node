/**
 * Error hierarchy.
 *
 * Every error the client raises on purpose is a `ThunderduckError`, so callers
 * can catch one type and still branch on `status`. Server-provided text is in
 * `detail`; the transport's own error is in `cause`.
 */
export class ThunderduckError extends Error {
  /** HTTP status, when the error came from a response. */
  readonly status?: number;
  /** The server's `detail` (or raw body) when there was one. */
  readonly detail?: string;

  constructor(
    message: string,
    options: { status?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.detail = options.detail;
  }
}

/** The token missing, expired, rejected or lacking access (HTTP 401/403). */
export class ThunderduckAuthError extends ThunderduckError {}

/**
 * The identity authenticated but has no usable Thunderduck account (not signed
 * in to the console yet, or suspended). Sending them to the console once fixes
 * the first case; nothing the client can do fixes the second.
 */
export class ThunderduckNoAccessError extends ThunderduckError {}

/** The run finished as `error` — `detail` is the engine's message. */
export class ThunderduckQueryError extends ThunderduckError {}

/** The run was cancelled before it finished. */
export class ThunderduckCancelledError extends ThunderduckError {}

/** Polling gave up before the run reached a terminal status. */
export class ThunderduckTimeoutError extends ThunderduckError {}

/** The run succeeded but its stored result has aged out (HTTP 409). Re-run. */
export class ThunderduckResultExpiredError extends ThunderduckError {}
