import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  Thunderduck,
  ThunderduckAuthError,
  ThunderduckCancelledError,
  ThunderduckError,
  ThunderduckNoAccessError,
  ThunderduckQueryError,
  ThunderduckResultExpiredError,
  ThunderduckTimeoutError,
} from "../dist/index.js";

/**
 * A throwaway HTTP server. `handler` gets the parsed request and a small
 * `reply` helper; every request is recorded so tests can assert on method,
 * path, headers and body.
 */
async function stub(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const entry = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: raw === "" ? undefined : JSON.parse(raw),
    };
    requests.push(entry);

    const reply = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    await handler(entry, reply, res);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const execution = (overrides = {}) => ({
  uuid: "11111111-1111-1111-1111-111111111111",
  status: "success",
  query: "select 1",
  start: "2026-11-24T10:00:00Z",
  end: "2026-11-24T10:00:01Z",
  execution_time_ms: 1000,
  error_message: null,
  result_location: "s3://results/one.parquet",
  result_row_count: 1,
  source: "api",
  ...overrides,
});

const job = (overrides = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  backend: "eks",
  namespace: "thunderduck",
  job_name: "query-abc",
  kubernetes_response: { status: "created" },
  ...overrides,
});

test("submits, polls, and walks every result page", async () => {
  let polls = 0;
  const api = await stub((request, reply) => {
    if (request.path === "/queries") {
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body, { sql: "select * from t", force_refresh: true });
      return reply(201, job());
    }
    if (request.path === "/executions/11111111-1111-1111-1111-111111111111") {
      polls += 1;
      // The first poll races the row insert: a 404 must mean "keep waiting".
      if (polls === 1) return reply(404, { detail: "execution not found" });
      return reply(200, execution({ status: polls === 2 ? "running" : "success" }));
    }
    if (request.path.startsWith("/executions/11111111-1111-1111-1111-111111111111/result")) {
      const url = new URL(request.path, "http://stub");
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const all = [
        [1, "a", true],
        [2, "b", false],
        [3, "c", null],
      ];
      const rows = all.slice(offset, offset + limit);
      return reply(200, {
        execution_uuid: "11111111-1111-1111-1111-111111111111",
        result_location: "s3://results/one.parquet",
        columns: ["n", "letter", "flag"],
        column_types: ["INTEGER", "VARCHAR", "BOOLEAN"],
        rows,
        row_count: rows.length,
        total: all.length,
        limit,
        offset,
      });
    }
    reply(500, { detail: `unexpected ${request.method} ${request.path}` });
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    const result = await td.query("select * from t", { pageSize: 2, forceRefresh: true });

    assert.equal(result.id, job().id);
    assert.deepEqual(result.columns, ["n", "letter", "flag"]);
    assert.deepEqual(result.columnTypes, ["INTEGER", "VARCHAR", "BOOLEAN"]);
    assert.equal(result.total, 3);
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.rows.map((row) => row[0]), [1, 2, 3]);
    assert.equal(result.execution.status, "success");
    assert.equal(result.execution.errorMessage, null);
    assert.equal(result.execution.resultLocation, "s3://results/one.parquet");

    assert.equal(polls, 3);
    assert.deepEqual(
      api.requests.map((request) => request.path),
      [
        "/queries",
        "/executions/11111111-1111-1111-1111-111111111111",
        "/executions/11111111-1111-1111-1111-111111111111",
        "/executions/11111111-1111-1111-1111-111111111111",
        `/executions/11111111-1111-1111-1111-111111111111/result?limit=2&offset=0`,
        `/executions/11111111-1111-1111-1111-111111111111/result?limit=2&offset=2`,
      ],
    );
    assert.equal(api.requests[0].headers.authorization, "Bearer tok");
  } finally {
    await api.close();
  }
});

test("refreshes the token once after a 401", async () => {
  const tokens = [];
  const flags = [];
  let current = "stale";
  const api = await stub((request, reply) => {
    if (request.path === "/queries") {
      tokens.push(request.headers.authorization);
      if (request.headers.authorization === "Bearer stale") {
        return reply(401, { detail: "token expired" });
      }
      return reply(201, job());
    }
    reply(200, execution());
  });

  try {
    const td = new Thunderduck({
      baseUrl: api.baseUrl,
      getToken: (forceRefresh) => {
        flags.push(forceRefresh);
        if (forceRefresh) current = "fresh";
        return current;
      },
      pollIntervalMs: 5,
    });
    await td.submit("select 1");
    await td.awaitExecution(job().id);
    assert.deepEqual(tokens, ["Bearer stale", "Bearer fresh"]);
    assert.equal(flags[0], false);
    assert.equal(flags[1], true);
  } finally {
    await api.close();
  }
});

test("a rejected static token is an auth error, not a retry loop", async () => {
  const api = await stub((request, reply) => reply(401, { detail: "invalid token" }));

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "bad" });
    await assert.rejects(td.submit("select 1"), (error) => {
      assert.ok(error instanceof ThunderduckAuthError);
      assert.equal(error.status, 401);
      assert.match(error.message, /invalid token/);
      return true;
    });
    assert.equal(api.requests.length, 1);
  } finally {
    await api.close();
  }
});

test("maps the console-account details to a no-access error", async () => {
  const api = await stub((request, reply) =>
    reply(404, {
      detail: "no thunderduck user for this identity; sign in to the console once",
    }),
  );

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok" });
    await assert.rejects(td.submit("select 1"), (error) => {
      assert.ok(error instanceof ThunderduckNoAccessError);
      assert.match(error.message, /console\.thunderduck\.ai/);
      return true;
    });
  } finally {
    await api.close();
  }
});

test("a failed run throws the engine message", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    return reply(200, execution({ status: "error", error_message: "Binder Error: no such table" }));
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    await assert.rejects(td.awaitExecution(job().id), (error) => {
      assert.ok(error instanceof ThunderduckQueryError);
      assert.match(error.message, /Binder Error/);
      assert.equal(error.detail, "Binder Error: no such table");
      return true;
    });
  } finally {
    await api.close();
  }
});

test("a cancelled run throws the cancelled error", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    return reply(200, execution({ status: "cancelled" }));
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    await assert.rejects(td.awaitExecution(job().id), ThunderduckCancelledError);
  } finally {
    await api.close();
  }
});

test("polling gives up at the deadline", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    return reply(200, execution({ status: "running" }));
  });

  try {
    const td = new Thunderduck({
      baseUrl: api.baseUrl,
      token: "tok",
      pollIntervalMs: 5,
      timeoutMs: 40,
    });
    await assert.rejects(td.awaitExecution(job().id), (error) => {
      assert.ok(error instanceof ThunderduckTimeoutError);
      assert.match(error.message, /did not finish/);
      return true;
    });
  } finally {
    await api.close();
  }
});

test("an expired stored result is its own error", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    if (request.path.includes("/result")) {
      return reply(409, { detail: "result expired" });
    }
    return reply(200, execution());
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    await assert.rejects(td.query("select 1"), (error) => {
      assert.ok(error instanceof ThunderduckResultExpiredError);
      assert.equal(error.status, 409);
      assert.match(error.message, /re-run/);
      return true;
    });
  } finally {
    await api.close();
  }
});

test("a statement with no stored result yields no rows", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    if (request.path.includes("/result")) return reply(404, { detail: "no stored result" });
    return reply(200, execution({ result_location: null, result_row_count: null }));
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    const result = await td.query("insert into t values (1)");
    assert.deepEqual(result.rows, []);
    assert.equal(result.total, 0);

    const batches = [];
    for await (const batch of td.iterate("insert into t values (1)")) batches.push(batch);
    assert.deepEqual(batches, []);
  } finally {
    await api.close();
  }
});

test("iterate stops at maxRows", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    if (request.path.startsWith("/executions/")) {
      if (request.path.includes("/result")) {
        const url = new URL(request.path, "http://stub");
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return reply(200, {
          execution_uuid: job().id,
          columns: ["n"],
          column_types: ["INTEGER"],
          rows: Array.from({ length: Math.min(limit, 10 - offset) }, (_, i) => [offset + i]),
          row_count: Math.min(limit, 10 - offset),
          total: 10,
          limit,
          offset,
        });
      }
      return reply(200, execution());
    }
    reply(500, {});
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    const rows = [];
    for await (const batch of td.iterate("select * from ten", { pageSize: 3, maxRows: 5 })) {
      rows.push(...batch.rows);
    }
    assert.equal(rows.length, 5);
  } finally {
    await api.close();
  }
});

test("cancel is best effort and keeps auth failures visible", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/executions/finished/cancel") return reply(404, { detail: "not found" });
    if (request.path === "/executions/live/cancel") return reply(202, { cancelled: true });
    if (request.path === "/executions/denied/cancel") return reply(403, { detail: "forbidden" });
    reply(500, {});
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok" });
    await td.cancel("finished");
    await td.cancel("live");
    await assert.rejects(td.cancel("denied"), ThunderduckAuthError);
  } finally {
    await api.close();
  }
});

test("catalog schema is mapped, including annotations and two-level catalogs", async () => {
  const api = await stub((request, reply) =>
    reply(200, {
      catalogs: [
        {
          name: "nessie",
          type: "nessie_iceberg",
          tables: [
            {
              name: "orders",
              kind: "table",
              columns: [
                { name: "id", type: "BIGINT" },
                { name: "total", type: "DECIMAL(18,2)", semantics: { description: "order total" } },
              ],
            },
          ],
          namespaces: null,
          error: null,
        },
        {
          name: "pg",
          type: "postgresql",
          tables: null,
          namespaces: [{ name: "public", tables: [{ name: "users", columns: [] }] }],
          error: "warehouse unreachable",
        },
      ],
      error: null,
    }),
  );

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok" });
    const schema = await td.catalogSchema();

    assert.equal(schema.catalogs.length, 2);
    assert.equal(schema.catalogs[0].name, "nessie");
    assert.equal(schema.catalogs[0].tables[0].columns[1].semantics.description, "order total");
    assert.equal(schema.catalogs[0].tables[0].columns[0].semantics, null);
    assert.equal(schema.catalogs[1].namespaces[0].tables[0].name, "users");
    assert.equal(schema.catalogs[1].error, "warehouse unreachable");
    assert.equal(api.requests[0].path, "/catalog/schema");
  } finally {
    await api.close();
  }
});

test("download fetches the presigned URL without the bearer", async () => {
  let presigned;
  const api = await stub((request, reply, res) => {
    if (request.path === `/executions/${job().id}/download-url`) {
      presigned = `${api.baseUrl}/presigned/one.parquet?X-Amz-Signature=abc`;
      return reply(200, { url: presigned, expires_in: 300 });
    }
    if (request.path.startsWith("/presigned/")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("PAR1data");
      return;
    }
    reply(500, {});
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok" });
    const { expiresIn } = await td.downloadUrl(job().id);
    assert.equal(expiresIn, 300);

    const response = await td.download(job().id);
    assert.equal(await response.text(), "PAR1data");

    const presignedRequest = api.requests.find((request) => request.path.startsWith("/presigned/"));
    assert.ok(presignedRequest);
    assert.equal(presignedRequest.headers.authorization, undefined);
  } finally {
    await api.close();
  }
});

test("follows a same-origin redirect and refuses a foreign one", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") {
      return reply(307, {}, { location: "/moved/queries" });
    }
    if (request.path === "/moved/queries") return reply(201, job());
    if (request.path === "/catalog/schema") {
      return reply(302, {}, { location: "https://evil.example.com/steal" });
    }
    reply(500, {});
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok" });
    const submitted = await td.submit("select 1");
    assert.equal(submitted.id, job().id);

    await assert.rejects(td.catalogSchema(), (error) => {
      assert.ok(error instanceof ThunderduckError);
      assert.match(error.message, /another host: https:\/\/evil\.example\.com/);
      return true;
    });
  } finally {
    await api.close();
  }
});

test("aborting a wait rejects with the caller's reason", async () => {
  const api = await stub((request, reply) => {
    if (request.path === "/queries") return reply(201, job());
    return reply(200, execution({ status: "running" }));
  });

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok", pollIntervalMs: 5 });
    const controller = new AbortController();
    const waiting = td.awaitExecution(job().id, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user closed the tab")), 15);
    await assert.rejects(waiting, /user closed the tab/);
  } finally {
    await api.close();
  }
});

test("constructor rejects an unusable configuration", () => {
  assert.throws(() => new Thunderduck({}), /Settings → API tokens/);
  assert.throws(
    () => new Thunderduck({ token: "a", getToken: () => "b" }),
    /not both/,
  );
  assert.throws(() => new Thunderduck({ token: "a", fetch: 42 }), /global fetch/);
});

test("submit surfaces a response without an id", async () => {
  const api = await stub((request, reply) => reply(201, { backend: "eks" }));

  try {
    const td = new Thunderduck({ baseUrl: api.baseUrl, token: "tok" });
    await assert.rejects(td.submit("select 1"), /no execution id/);
  } finally {
    await api.close();
  }
});
