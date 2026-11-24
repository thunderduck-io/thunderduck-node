import {
  ThunderduckAuthError,
  ThunderduckCancelledError,
  ThunderduckError,
  ThunderduckNoAccessError,
  ThunderduckQueryError,
  ThunderduckResultExpiredError,
  ThunderduckTimeoutError,
} from "./errors";
import type {
  CatalogSchema,
  DownloadUrl,
  Execution,
  QueryJob,
  QueryResult,
  ResultBatch,
  ResultPage,
  Row,
} from "./types";

const DEFAULT_BASE_URL = "https://api.thunderduck.ai";
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// The API distinguishes "this identity has no usable Thunderduck account" from
// every other 401/404 by detail text. Matching it is what turns a bare status
// into the sentence that actually helps someone.
const UNKNOWN_USER_DETAIL =
  "no thunderduck user for this identity; sign in to the console once";
const INACTIVE_USER_DETAIL = "user no longer active";
const NO_ACCESS_MESSAGE =
  "This account has no Thunderduck access yet — sign in to the console once at https://console.thunderduck.ai, then try again.";
const SUSPENDED_MESSAGE = "Your Thunderduck account is suspended.";

export interface ThunderduckOptions {
  /**
   * API token from the console (Settings → API tokens). Mutually exclusive
   * with `getToken`.
   */
  token?: string;
  /**
   * Supplies the bearer for each request, for tokens that rotate or expire.
   * Called with `true` after a 401 so it can force a refresh; returning the
   * same rejected token simply produces the auth error.
   */
  getToken?: (forceRefresh?: boolean) => string | Promise<string>;
  /** Origin of the API. Default `https://api.thunderduck.ai`. */
  baseUrl?: string;
  /** Injectable `fetch`, for tests and non-Node runtimes. */
  fetch?: typeof fetch;
  /** Poll cadence while a query runs. Default 1000 ms. */
  pollIntervalMs?: number;
  /** How long `awaitExecution()` waits before giving up. Default 300 s. */
  timeoutMs?: number;
  /** Per-HTTP-request ceiling. Default 30 s. */
  requestTimeoutMs?: number;
  /** Redirects followed, same-origin only. Default 3. */
  maxRedirects?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface QueryOptions extends RequestOptions {
  /** Overwrite the client's default poll cadence for this call. */
  pollIntervalMs?: number;
  /** Overwrite the client's default wait ceiling for this call. */
  timeoutMs?: number;
  /** Rows per request when walking the result. Default 1000. */
  pageSize?: number;
  /** Stop after this many rows. Default: the whole result. */
  maxRows?: number;
  /** Ask the API to skip a cached result. */
  forceRefresh?: boolean;
}

interface RawResponse {
  status: number;
  text: string;
  headers: Headers;
}

/**
 * Client for the Thunderduck REST API.
 *
 * ```ts
 * const td = new Thunderduck({ token: process.env.THUNDERDUCK_TOKEN! });
 * const { columns, rows } = await td.query("select * from nessie.orders limit 10");
 * ```
 */
export class Thunderduck {
  readonly baseUrl: string;

  private readonly token?: string;
  private readonly getToken?: (forceRefresh?: boolean) => string | Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRedirects: number;

  constructor(options: ThunderduckOptions = {}) {
    if (!options.token && !options.getToken) {
      throw new ThunderduckError(
        "either `token` or `getToken` is required (create one in the console: Settings → API tokens)",
      );
    }
    if (options.token && options.getToken) {
      throw new ThunderduckError("pass `token` or `getToken`, not both");
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new ThunderduckError(
        "no global fetch available; pass one as `fetch` (Node 18+ has it)",
      );
    }

    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = options.token;
    this.getToken = options.getToken;
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  // ---- queries -------------------------------------------------------------

  /** Submit SQL and return its execution id, without waiting for it. */
  async submit(sql: string, options: RequestOptions & { forceRefresh?: boolean } = {}): Promise<QueryJob> {
    const body: Record<string, unknown> = { sql };
    if (options.forceRefresh !== undefined) body.force_refresh = options.forceRefresh;

    const response = await this.send("/queries", {
      method: "POST",
      body,
      signal: options.signal,
    });
    if (response.status !== 200 && response.status !== 201) {
      this.fail(response, "submit");
    }

    const raw = this.parse<Record<string, unknown>>(response.text, "submit");
    const id = raw.id;
    if (id === undefined || id === null || `${id}` === "") {
      throw new ThunderduckError("the API returned no execution id for this query");
    }

    return {
      id: `${id}`,
      backend: typeof raw.backend === "string" ? raw.backend : "eks",
      namespace: typeof raw.namespace === "string" ? raw.namespace : null,
      jobName: typeof raw.job_name === "string" ? raw.job_name : null,
      raw,
    };
  }

  /** One execution by id. Throws when it does not exist. */
  async execution(id: string, options: RequestOptions = {}): Promise<Execution> {
    const execution = await this.executionOrNull(id, options);
    if (execution === null) {
      throw new ThunderduckError(`execution ${id} not found`, { status: 404 });
    }
    return execution;
  }

  /**
   * Poll until the run is terminal. Returns only `success`; throws
   * `ThunderduckQueryError` on `error`, `ThunderduckCancelledError` on
   * `cancelled`, and `ThunderduckTimeoutError` when the deadline passes.
   *
   * A 404 while polling means "not visible yet" — the row is inserted at submit
   * time, but a poll can still race it — so it keeps polling rather than
   * failing.
   */
  async awaitExecution(id: string, options: QueryOptions = {}): Promise<Execution> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? this.pollIntervalMs;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const execution = await this.executionOrNull(id, options);
      if (execution !== null) {
        if (execution.status === "success") return execution;
        if (execution.status === "error") {
          throw new ThunderduckQueryError(
            execution.errorMessage ?? "query failed without a message",
            { detail: execution.errorMessage ?? undefined },
          );
        }
        if (execution.status === "cancelled") {
          throw new ThunderduckCancelledError("query was cancelled");
        }
      }

      if (Date.now() >= deadline) {
        throw new ThunderduckTimeoutError(
          `query ${id} did not finish within ${timeoutMs} ms`,
        );
      }
      await sleep(pollIntervalMs, options.signal);
    }
  }

  /** A fully buffered query: submit, wait, then walk every result page. */
  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const job = await this.submit(sql, options);
    const execution = await this.awaitExecution(job.id, options);

    const rows: Row[] = [];
    let columns: string[] = [];
    let columnTypes: string[] = [];
    let total = 0;

    for await (const batch of this.batches(job.id, options)) {
      columns = batch.columns;
      columnTypes = batch.columnTypes;
      total = batch.total;
      rows.push(...batch.rows);
    }

    return { id: job.id, columns, columnTypes, rows, total, offset: 0, execution };
  }

  /**
   * Submit, wait, then yield result pages — for results too large to buffer.
   * A statement with no stored result (an INSERT, say) yields nothing.
   */
  async *iterate(sql: string, options: QueryOptions = {}): AsyncGenerator<ResultBatch> {
    const job = await this.submit(sql, options);
    await this.awaitExecution(job.id, options);
    yield* this.batches(job.id, options);
  }

  /** One page of an execution's stored result, or null when it stored none. */
  async resultPage(
    id: string,
    options: RequestOptions & { limit?: number; offset?: number } = {},
  ): Promise<ResultPage | null> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const offset = options.offset ?? 0;
    const query = new URLSearchParams({ limit: `${limit}`, offset: `${offset}` });

    const response = await this.send(`/executions/${encodeURIComponent(id)}/result?${query}`, {
      method: "GET",
      signal: options.signal,
    });

    if (response.status === 404) return null; // non-SELECT: nothing stored
    if (response.status === 409) {
      throw new ThunderduckResultExpiredError(
        `the run succeeded but its stored result has expired; re-run the query${suffix(this.detailOf(response))}`,
        { status: 409, detail: this.detailOf(response) },
      );
    }
    if (response.status !== 200) this.fail(response, "result fetch");

    const raw = this.parse<Record<string, unknown>>(response.text, "result fetch");
    const rows = Array.isArray(raw.rows) ? (raw.rows as Row[]) : [];
    return {
      id: typeof raw.execution_uuid === "string" ? raw.execution_uuid : id,
      columns: asStrings(raw.columns),
      columnTypes: asStrings(raw.column_types),
      rows,
      rowCount: toNumber(raw.row_count) ?? rows.length,
      total: toNumber(raw.total) ?? rows.length,
      limit: toNumber(raw.limit) ?? limit,
      offset: toNumber(raw.offset) ?? offset,
    };
  }

  /**
   * Best-effort cancel: an unknown or already-finished run is not an error.
   * A rejected token still is — swallowing it would make a stop button look
   * like it worked while hiding a dead credential.
   */
  async cancel(id: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.send(`/executions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      signal: options.signal,
    });
    if (response.status === 200 || response.status === 202 || response.status === 204) return;
    if (response.status === 401 || response.status === 403) this.fail(response, "cancel");
    if (response.status === 404) return;
    // Everything else is a best-effort miss: the run is already over, or the
    // server is mid-transition. Nothing useful to do with it.
  }

  // ---- catalog -------------------------------------------------------------

  /** Catalogs, namespaces, tables and columns this token may see. */
  async catalogSchema(options: RequestOptions = {}): Promise<CatalogSchema> {
    const response = await this.send("/catalog/schema", {
      method: "GET",
      signal: options.signal,
    });
    if (response.status !== 200) this.fail(response, "catalog fetch");

    const raw = this.parse<Record<string, unknown>>(response.text, "catalog fetch");
    const catalogs = Array.isArray(raw.catalogs) ? raw.catalogs : [];
    return {
      catalogs: catalogs.map((tree) => toCatalogTree(tree as Record<string, unknown>)),
      error: typeof raw.error === "string" ? raw.error : null,
    };
  }

  // ---- downloads -----------------------------------------------------------

  /** Mint a short-lived presigned URL for the run's stored result. */
  async downloadUrl(id: string, options: RequestOptions = {}): Promise<DownloadUrl> {
    const response = await this.send(
      `/executions/${encodeURIComponent(id)}/download-url`,
      { method: "GET", signal: options.signal },
    );
    if (response.status !== 200) this.fail(response, "download-url");

    const raw = this.parse<Record<string, unknown>>(response.text, "download-url");
    if (typeof raw.url !== "string") {
      throw new ThunderduckError("the API returned no download URL for this execution");
    }
    return { url: raw.url, expiresIn: toNumber(raw.expires_in) ?? 0 };
  }

  /**
   * The stored result, as the presigned GET response. Never sends the bearer:
   * the URL is self-authenticating, and a client that attached our token to it
   * would hand the token to whatever host the URL names.
   */
  async download(id: string, options: RequestOptions = {}): Promise<Response> {
    const { url } = await this.downloadUrl(id, options);
    return this.fetchImpl(url, { signal: options.signal });
  }

  // ---- internals -----------------------------------------------------------

  private async *batches(
    id: string,
    options: QueryOptions,
  ): AsyncGenerator<ResultBatch> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    while (offset < total && offset < maxRows) {
      const remaining = maxRows - offset;
      const limit = Math.max(1, Math.min(pageSize, Number.isFinite(remaining) ? remaining : pageSize));
      const page = await this.resultPage(id, { limit, offset, signal: options.signal });
      if (page === null) return; // non-SELECT
      total = page.total;
      if (page.rows.length === 0) return;

      yield {
        columns: page.columns,
        columnTypes: page.columnTypes,
        rows: page.rows,
        total: page.total,
        offset: page.offset,
      };

      offset = page.offset + page.rows.length;
      if (page.rows.length < limit) return; // short page: nothing left
    }
  }

  private async executionOrNull(id: string, options: RequestOptions): Promise<Execution | null> {
    const response = await this.send(`/executions/${encodeURIComponent(id)}`, {
      method: "GET",
      signal: options.signal,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) this.fail(response, "status check");

    const raw = this.parse<Record<string, unknown>>(response.text, "status check");
    return {
      id: typeof raw.uuid === "string" ? raw.uuid : id,
      status: typeof raw.status === "string" ? raw.status : "running",
      query: typeof raw.query === "string" ? raw.query : "",
      errorMessage: asString(raw.error_message),
      resultLocation: asString(raw.result_location),
      resultRowCount: toNumber(raw.result_row_count),
      startedAt: asString(raw.start),
      finishedAt: asString(raw.end),
      executionTimeMs: toNumber(raw.execution_time_ms),
      queryTimeMs: toNumber(raw.query_time_ms),
      totalRuntimeMs: toNumber(raw.total_runtime_ms),
      peakMemoryBytes: toNumber(raw.peak_memory_bytes),
      source: asString(raw.source),
      raw,
    };
  }

  /**
   * One logical request: token, redirects (same origin only), one retry after a
   * 401 when a token provider can refresh.
   */
  private async send(
    path: string,
    options: { method: string; body?: unknown; signal?: AbortSignal; tokenless?: boolean },
  ): Promise<RawResponse> {
    let refreshed = false;

    for (;;) {
      const token = options.tokenless
        ? undefined
        : await this.currentToken(refreshed);

      const response = await this.followRedirects(path, {
        method: options.method,
        body: options.body,
        signal: options.signal,
        token,
      });

      if (
        response.status === 401 &&
        !options.tokenless &&
        !refreshed &&
        this.getToken !== undefined
      ) {
        refreshed = true;
        continue;
      }
      return response;
    }
  }

  private async followRedirects(
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal; token?: string },
  ): Promise<RawResponse> {
    let url = new URL(`${this.baseUrl}${path}`);
    const origin = url.origin;
    let method = init.method;
    let body = init.body === undefined ? undefined : JSON.stringify(init.body);

    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const response = await this.fetchText(url, { method, body, headers, signal: init.signal });

      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (location === null) return response;

      if (hop >= this.maxRedirects) {
        throw new ThunderduckError(`too many redirects for ${method} ${url.pathname}`);
      }

      const next = new URL(location, url);
      if (next.origin !== origin) {
        // The bearer must never travel to a host we do not control, and a
        // silent cross-origin hop is exactly how it would.
        throw new ThunderduckError(
          `refusing to follow a redirect to another host: ${next.origin}`,
        );
      }

      url = next;
      if (response.status === 303) {
        method = "GET";
        body = undefined;
      }
    }
  }

  private async fetchText(
    url: URL,
    init: { method: string; body?: string; headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<RawResponse> {
    const { signal, dispose } = combineWithTimeout(init.signal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        body: init.body,
        headers: init.headers,
        redirect: "manual",
        signal,
      });
      const text = await response.text();
      return { status: response.status, text, headers: response.headers };
    } catch (error) {
      if (signal.aborted && signal.reason instanceof ThunderduckTimeoutError) {
        throw signal.reason;
      }
      if (signal.aborted) throw error; // caller's abort, delivered as-is
      throw new ThunderduckError(
        `request to ${url.origin}${url.pathname} failed: ${messageOf(error)}`,
        { cause: error },
      );
    } finally {
      dispose();
    }
  }

  private async currentToken(forceRefresh: boolean): Promise<string> {
    if (this.getToken !== undefined) {
      const token = await this.getToken(forceRefresh);
      if (typeof token !== "string" || token === "") {
        throw new ThunderduckAuthError("getToken() returned an empty token");
      }
      return token;
    }
    return this.token as string;
  }

  private parse<T>(text: string, context: string): T {
    if (text === "") {
      throw new ThunderduckError(`empty response body from ${context}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ThunderduckError(`unparseable response body from ${context}`, {
        detail: text.slice(0, 200),
        cause: error,
      });
    }
  }

  private detailOf(response: RawResponse): string | undefined {
    if (response.text === "") return undefined;
    try {
      const parsed = JSON.parse(response.text) as Record<string, unknown>;
      const detail = parsed.detail ?? parsed.message ?? parsed.error;
      if (typeof detail === "string") return detail;
      if (detail !== undefined) return JSON.stringify(detail);
    } catch {
      // Not JSON: fall through to the raw text.
    }
    return response.text.slice(0, 500);
  }

  /** Turn an unexpected status into the most specific error this client has. */
  private fail(response: RawResponse, context: string): never {
    const detail = this.detailOf(response);
    const { status } = response;

    if (status === 404 && detail === UNKNOWN_USER_DETAIL) {
      throw new ThunderduckNoAccessError(NO_ACCESS_MESSAGE, { status, detail });
    }
    if (status === 401 && detail === INACTIVE_USER_DETAIL) {
      throw new ThunderduckNoAccessError(SUSPENDED_MESSAGE, { status, detail });
    }
    if (status === 401 || status === 403) {
      throw new ThunderduckAuthError(
        `authentication failed (HTTP ${status})${suffix(detail)}`,
        { status, detail },
      );
    }
    if (status === 409) {
      throw new ThunderduckResultExpiredError(
        `the run succeeded but its stored result has expired; re-run the query${suffix(detail)}`,
        { status, detail },
      );
    }
    throw new ThunderduckError(
      `${context} failed (HTTP ${status})${suffix(detail)}`,
      { status, detail },
    );
  }
}

// ---- helpers ---------------------------------------------------------------

function suffix(detail: string | undefined): string {
  return detail === undefined || detail === "" ? "" : `: ${detail}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => `${item}`) : [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toCatalogTree(raw: Record<string, unknown>) {
  const tables = Array.isArray(raw.tables) ? raw.tables : null;
  const namespaces = Array.isArray(raw.namespaces) ? raw.namespaces : null;
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    type: asString(raw.type),
    tables: tables === null ? null : tables.map((table) => toCatalogTable(table as Record<string, unknown>)),
    namespaces:
      namespaces === null
        ? null
        : namespaces.map((namespace) => {
            const entry = namespace as Record<string, unknown>;
            const nsTables = Array.isArray(entry.tables) ? entry.tables : [];
            return {
              name: typeof entry.name === "string" ? entry.name : "",
              tables: nsTables.map((table) => toCatalogTable(table as Record<string, unknown>)),
            };
          }),
    error: asString(raw.error),
  };
}

function toCatalogTable(raw: Record<string, unknown>) {
  const columns = Array.isArray(raw.columns) ? raw.columns : [];
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    kind: typeof raw.kind === "string" ? raw.kind : "table",
    columns: columns.map((column) => {
      const entry = column as Record<string, unknown>;
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        type: typeof entry.type === "string" ? entry.type : "",
        semantics:
          entry.semantics !== null && typeof entry.semantics === "object"
            ? (entry.semantics as Record<string, unknown>)
            : null,
      };
    }),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One abort signal that fires on the caller's abort or on our timeout.
 * `AbortSignal.any` would do this on newer runtimes; combining by hand keeps
 * Node 18 working.
 */
function combineWithTimeout(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller?.reason);
  const timer = setTimeout(
    () =>
      controller.abort(
        new ThunderduckTimeoutError(`request timed out after ${timeoutMs} ms`),
      ),
    timeoutMs,
  );

  if (caller !== undefined) {
    if (caller.aborted) onAbort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}
