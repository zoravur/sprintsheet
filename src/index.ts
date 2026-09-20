import { serve } from "bun";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import index from "./index.html";
import { allDataFiles, TEST_DATABASES } from "./lib/databases";
import { DATA_ROUTE_PREFIX, DUCKDB_ASSET_PREFIX } from "./lib/paths";

// ---- static data served to DuckDB -----------------------------------------
// Every relation's CSV lives on disk. The browser's DuckDB-wasm reads them over
// HTTP via `registerFileURL`, so they are served straight from here. Only files
// named in the database registry are exposed.
const dataDir = path.join(import.meta.dir, "data");
const dataFiles = new Set(allDataFiles());

function serveData(file: string): Response {
  if (!dataFiles.has(file)) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(path.join(dataDir, file)), {
    headers: { "content-type": "text/csv; charset=utf-8" },
  });
}

// ---- persisted databases ---------------------------------------------------
// The browser dumps its DuckDB state here as DuckDB files: one `<relation>.parquet`
// per table (types preserved) plus `views.sql`. We store them on disk and hand
// them back on the next load. Only registered ids/filenames are accepted, so a
// path can never escape `data/saved`.
const savedDir = path.join(dataDir, "saved");
const databaseIds = new Set(TEST_DATABASES.map((db) => db.id));
const allowedFiles = new Map<string, Set<string>>();
for (const db of TEST_DATABASES) {
  allowedFiles.set(db.id, new Set([...db.relations.map((relation) => `${relation.name}.parquet`), "views.sql"]));
}

function resolveSavedFile(id: string, file: string): string | null {
  const allowed = allowedFiles.get(id);
  return allowed?.has(file) ? path.join(savedDir, id, file) : null;
}

async function getSavedFile(id: string, file: string): Promise<Response> {
  const target = resolveSavedFile(id, file);
  if (!target) return new Response("Not found", { status: 404 });
  const blob = Bun.file(target);
  if (!(await blob.exists())) return new Response("Not found", { status: 404 });
  const contentType = file.endsWith(".parquet") ? "application/octet-stream" : "text/plain; charset=utf-8";
  return new Response(blob, { headers: { "content-type": contentType } });
}

async function putSavedFile(id: string, file: string, req: Request): Promise<Response> {
  const target = resolveSavedFile(id, file);
  if (!target) return new Response("Not found", { status: 404 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  await Bun.write(target, bytes);
  return Response.json({ ok: true, databaseId: id, file, bytes: bytes.length });
}

async function deleteSaved(id: string): Promise<Response> {
  if (!databaseIds.has(id)) return new Response("Unknown database", { status: 404 });
  await rm(path.join(savedDir, id), { recursive: true, force: true });
  return Response.json({ ok: true });
}

// DuckDB-wasm ships a worker + a wasm module per bundle. We serve them from
// node_modules instead of a CDN so the app is fully self-hosted. Only these
// known filenames are exposed.
const DUCKDB_ASSETS: Record<string, string> = {
  "duckdb-mvp.wasm": "application/wasm",
  "duckdb-eh.wasm": "application/wasm",
  "duckdb-browser-mvp.worker.js": "text/javascript; charset=utf-8",
  "duckdb-browser-eh.worker.js": "text/javascript; charset=utf-8",
};

function serveDuckDBAsset(name: string): Response {
  const contentType = DUCKDB_ASSETS[name];
  if (!contentType) return new Response("Not found", { status: 404 });
  // `import.meta.resolve` yields a percent-encoded file URL; `Bun.file` wants a
  // real path, so decode it (the workspace path contains a space).
  const filePath = fileURLToPath(import.meta.resolve(`@duckdb/duckdb-wasm/dist/${name}`));
  return new Response(Bun.file(filePath), { headers: { "content-type": contentType } });
}

const server = serve({
  routes: {
    // Relation CSVs, fetched by DuckDB over HTTP (range requests supported).
    [`${DATA_ROUTE_PREFIX}:file`]: req => serveData(req.params.file),

    // Persisted database files (GET to restore, PUT to save, DELETE to reset).
    "/api/database/:db": {
      DELETE: req => deleteSaved(req.params.db),
    },
    "/api/database/:db/:file": {
      GET: req => getSavedFile(req.params.db, req.params.file),
      PUT: req => putSavedFile(req.params.db, req.params.file, req),
    },

    // DuckDB wasm bundle + worker script.
    [`${DUCKDB_ASSET_PREFIX}:asset`]: req => serveDuckDBAsset(req.params.asset),

    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async req => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
