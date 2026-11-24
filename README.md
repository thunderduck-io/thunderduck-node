# thunderduck (Node)

The official TypeScript client for the [thunderduck](https://thunderduck.ai)
REST API. Submit SQL, wait for the run, page the result, browse the catalog and
mint download links — from Node 18, Bun, Deno or any runtime with `fetch`.

```bash
npm install @thunderduck/client
```

Zero runtime dependencies. Ships ESM and CommonJS with TypeScript types.

[Source on GitHub](https://github.com/thunderduck-io/thunderduck-node) ·
[Documentation](https://docs.thunderduck.ai/clients/node) ·
[npm](https://www.npmjs.com/package/@thunderduck/client)

## Connect

Create an API token in the console (**Settings → API tokens**; it is shown
once), then:

```ts
import { Thunderduck } from "@thunderduck/client";

const td = new Thunderduck({ token: process.env.THUNDERDUCK_TOKEN! });

const { columns, rows } = await td.query(
  'select * from "tndr_postgres_demo"."ecommerce"."orders" limit 10',
);

console.log(columns);
for (const row of rows) console.log(row);
```

`new Thunderduck()` defaults to `https://api.thunderduck.ai`. It never falls
back to an unauthenticated request: without `token` or `getToken` it throws.

## API

| Member | What it does |
| --- | --- |
| `query(sql, options?)` | Submit, wait, and return every row. |
| `iterate(sql, options?)` | Submit, wait, then yield result pages (`AsyncGenerator`). |
| `submit(sql, options?)` | Submit only; returns `{ id, backend, namespace, jobName }`. |
| `execution(id)` | One execution; throws when it does not exist. |
| `awaitExecution(id, options?)` | Poll until `success`; throws on `error`, `cancelled` or timeout. |
| `resultPage(id, { limit, offset })` | One page of a stored result, or `null` when none was stored. |
| `cancel(id)` | Best-effort cancel. Unknown or finished runs are not an error. |
| `catalogSchema()` | Catalogs, namespaces, tables and columns this token can see. |
| `downloadUrl(id)` | Short-lived presigned URL for the stored result. |
| `download(id)` | `fetch` that URL and return the `Response` — no bearer attached. |

### Options

`ThunderduckOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | — | API token. Mutually exclusive with `getToken`. |
| `getToken(forceRefresh?)` | — | Supplies a token per request; called with `true` once after a 401 so it can refresh. |
| `baseUrl` | `https://api.thunderduck.ai` | API origin. |
| `fetch` | global `fetch` | Injectable transport, for tests or a non-Node runtime. |
| `pollIntervalMs` | `1000` | Poll cadence while a query runs. |
| `timeoutMs` | `300000` | How long `awaitExecution` waits before giving up. |
| `requestTimeoutMs` | `30000` | Ceiling for one HTTP request. |
| `maxRedirects` | `3` | Redirects followed, same origin only. |

Every query-level method accepts `{ signal }` (an `AbortSignal`).
`query`/`iterate` also take `pollIntervalMs`, `timeoutMs`, `pageSize`
(default 1000), `maxRows` and `forceRefresh`.

### Errors

All errors extend `ThunderduckError`, which carries `status` and the server's
`detail` when there was one:

- `ThunderduckAuthError` — 401/403: missing, expired or rejected token.
- `ThunderduckNoAccessError` — authenticated, but no usable account (never
  signed in to the console, or suspended).
- `ThunderduckQueryError` — the run finished as `error`; `message` is the
  engine's message.
- `ThunderduckCancelledError` — the run was cancelled.
- `ThunderduckTimeoutError` — polling or a request hit its deadline.
- `ThunderduckResultExpiredError` — the run succeeded but its stored result
  aged out (HTTP 409). Re-run the query.

## Streaming large results

`query()` buffers everything, which is convenient and wrong for big exports.
Use `iterate()` when the result does not fit in memory:

```ts
for await (const batch of td.iterate("select * from lake.orders", {
  pageSize: 10_000,
})) {
  for (const row of batch.rows) {
    // write to a file, push to a queue, ...
  }
  console.log(`${batch.offset + batch.rows.length} / ${batch.total}`);
}
```

`maxRows` stops early; `pageSize` is a request hint, and the server may return
fewer rows per page.

## Downloads

The result is stored as Parquet. Ask for a presigned URL when you want the
client to fetch it, or hand the URL to another process:

```ts
const response = await td.download(executionId);
await pipeline(Readable.fromWeb(response.body!), createWriteStream("rows.parquet"));
```

`download()` deliberately sends no `Authorization` header: the presigned URL
authenticates itself, and attaching our token would hand it to the storage
host.

## How it works, and what follows from that

Every statement is submitted to thunderduck's REST API, which runs it as an
isolated workload; results are paged back over HTTP. That model has
consequences worth knowing up front:

- **Latency.** Expect seconds, not milliseconds, before the first row. Built
  for analytics and batch jobs, not tight interactive loops.
- **Read-only.** No DML, no DDL, no transactions.
- **Results expire.** A stored result is a cache, not a database. Keep the
  execution id if you need to page it again later, and expect a
  `ThunderduckResultExpiredError` once it ages out.
- **Row ceiling.** The server caps page size and stored result size. Aggregate
  in SQL rather than pulling raw rows.
- **Same-origin redirects only.** A redirect to another host is refused rather
  than followed with the bearer token.
- **Nothing is retried twice.** A 401 is retried once when `getToken` can
  refresh; other failures surface immediately.

## Development

```bash
npm install
npm run typecheck
npm test        # builds, then runs node:test against a local HTTP stub
```

The tests need no token and no network: each one starts a `node:http` server on
loopback and points the client at it.

## License

Apache-2.0. See [LICENSE](LICENSE).

This repository is a mirror of Thunderduck's internal source; see
[CONTRIBUTING.md](CONTRIBUTING.md) for how issues and pull requests are handled,
and [SECURITY.md](SECURITY.md) to report a vulnerability.
