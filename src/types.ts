/** A value as it appears in a result cell. */
export type Cell =
  | null
  | boolean
  | number
  | string
  | Cell[]
  | { [key: string]: Cell };

export type Row = Cell[];

/**
 * `queued`/`running` are in flight; `success`/`error`/`cancelled` are terminal.
 * The union keeps a string arm because the API may add a status before this
 * package is updated, and callers should not crash on it.
 */
export type ExecutionStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | (string & {});

export interface Execution {
  /** Same value as `submit()` returned; the id `/executions/{id}` takes. */
  id: string;
  status: ExecutionStatus;
  query: string;
  errorMessage: string | null;
  /** Where the result Parquet lives (S3 URI), when the run stored one. */
  resultLocation: string | null;
  resultRowCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  executionTimeMs: number | null;
  queryTimeMs: number | null;
  totalRuntimeMs: number | null;
  peakMemoryBytes: number | null;
  source: string | null;
  /** The untouched response, for fields this package does not model yet. */
  raw: Record<string, unknown>;
}

/** What `POST /queries` returns. */
export interface QueryJob {
  id: string;
  /** `eks`, `ecs`, or `cache` (served from a prior result; no new run). */
  backend: string;
  namespace: string | null;
  jobName: string | null;
  raw: Record<string, unknown>;
}

export interface ResultPage {
  id: string;
  columns: string[];
  /** Parallel to `columns`; empty when the server did not send types. */
  columnTypes: string[];
  rows: Row[];
  /** Rows in this page. */
  rowCount: number;
  /** Rows in the whole stored result. */
  total: number;
  limit: number;
  offset: number;
}

/** One page produced by `iterate()`. */
export interface ResultBatch {
  columns: string[];
  columnTypes: string[];
  rows: Row[];
  total: number;
  offset: number;
}

/** A fully buffered query: `query()` walks every page for this. */
export interface QueryResult extends ResultBatch {
  id: string;
  execution: Execution;
}

export interface CatalogColumn {
  name: string;
  type: string;
  /** Present only when someone annotated the column's meaning. */
  semantics: Record<string, unknown> | null;
}

export interface CatalogTable {
  name: string;
  kind: "table" | "view" | string;
  columns: CatalogColumn[];
}

export interface CatalogNamespace {
  name: string;
  tables: CatalogTable[];
}

export interface CatalogTree {
  name: string;
  /** Integration type, e.g. `nessie_iceberg`, `postgresql`, `s3`. */
  type: string | null;
  /** Two-level catalogs (catalog.table) put tables here. */
  tables: CatalogTable[] | null;
  /** Three-level catalogs (catalog.schema.table) put namespaces here. */
  namespaces: CatalogNamespace[] | null;
  error: string | null;
}

export interface CatalogSchema {
  catalogs: CatalogTree[];
  error: string | null;
}

export interface DownloadUrl {
  url: string;
  /** Seconds until the presigned URL stops working. */
  expiresIn: number;
}
