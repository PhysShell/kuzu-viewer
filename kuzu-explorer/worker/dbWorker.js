"use strict";
/*
 * dbWorker.js — runs under the *system* Node.js (not VS Code's Electron host),
 * so it can load Kuzu's native addon without ABI mismatches. The extension
 * spawns this file and talks to it over stdin/stdout using newline-delimited
 * JSON-RPC.
 *
 * Protocol:
 *   request  (stdin) : {"id": <n>, "method": <string>, "params": <object>}\n
 *   response (stdout): {"id": <n>, "ok": true,  "result": <any>}\n
 *                    | {"id": <n>, "ok": false, "error": <string>}\n
 *
 * Everything that is NOT a protocol message (e.g. Kuzu native logging) is kept
 * off stdout; diagnostics go to stderr.
 *
 * This mirrors the behaviour of main.py in the parent FastAPI project:
 * read-only by default, snapshot-copy fallback when the DB file is locked by
 * another process, and a write-query guard in read-only mode.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

let kuzu;
try {
  kuzu = require("kuzu");
} catch (e) {
  // Report the load failure on the first request rather than crashing silently.
  kuzu = null;
}

const WRITE_KEYWORDS = new Set([
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE",
  "DROP", "ALTER", "COPY", "INSTALL", "LOAD",
]);

const state = {
  db: null,
  conn: null,
  path: null,
  readOnly: false,
  tempDir: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  process.stderr.write("[dbWorker] " + args.join(" ") + "\n");
}

// JSON replacer so BigInt (Kuzu INT64) and friends survive serialization.
function jsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function send(message) {
  process.stdout.write(JSON.stringify(message, jsonReplacer) + "\n");
}

function isLockError(err) {
  const msg = String(err && err.message ? err.message : err).toLowerCase();
  return msg.includes("could not set lock") || msg.includes("lock on file");
}

function isWriteQuery(query) {
  const tokens = [];
  for (let line of String(query).split(/\r?\n/)) {
    line = line.split("//")[0]; // strip line comments
    for (const tok of line.toUpperCase().split(/\s+/)) {
      if (tok) tokens.push(tok);
    }
  }
  return tokens.some((t) => WRITE_KEYWORDS.has(t));
}

function formatId(idObj) {
  if (!idObj) return null;
  return `${idObj.table}_${idObj.offset}`;
}

// Pick a human-friendly label for a graph node from its properties, falling
// back to the table/label name when no obvious name-like property exists.
const LABEL_KEYS = ["name", "title", "label", "displayName", "key", "id", "db_id"];
function pickLabel(props, fallback) {
  for (const k of LABEL_KEYS) {
    const v = props[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v);
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
  }
  return fallback;
}

// Color palette; node types are assigned distinct colors by table order.
const TYPE_PALETTE = [
  "#4f8cc9", "#e0a458", "#6cbf84", "#c96f9b",
  "#9b7fd1", "#d1786f", "#5bb3c9", "#b3a14f",
];

async function releaseDb() {
  const { conn, db, tempDir } = state;
  if (conn) {
    try { await conn.close(); } catch (_) { /* ignore */ }
  }
  if (db) {
    try { await db.close(); } catch (_) { /* ignore */ }
  }
  state.conn = null;
  state.db = null;
  state.path = null;
  state.readOnly = false;
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    state.tempDir = null;
  }
}

// Mirror the DB into a temp dir so we can open it read-only even when another
// process holds the file lock. Returns { tempRoot, openPath }.
function copyDbForReadonly(srcPath) {
  const abs = path.resolve(srcPath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kuzu-explorer-ro-"));
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const dstDir = path.join(tempRoot, path.basename(abs.replace(/[/\\]+$/, "")) || "db");
      fs.cpSync(abs, dstDir, { recursive: true });
      return { tempRoot, openPath: dstDir };
    }
    // File-based DB: copy the main file plus its WAL / shadow siblings.
    const parent = path.dirname(abs) || ".";
    const base = path.basename(abs);
    const stem = base.endsWith(".kuzu") ? base.slice(0, -".kuzu".length) : base;
    let copied = 0;
    for (const fname of fs.readdirSync(parent)) {
      if (fname === base || fname.startsWith(stem + ".")) {
        fs.copyFileSync(path.join(parent, fname), path.join(tempRoot, fname));
        copied += 1;
      }
    }
    if (copied === 0) {
      throw new Error(`No Kuzu DB files found near ${abs}`);
    }
    return { tempRoot, openPath: path.join(tempRoot, base) };
  } catch (e) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw e;
  }
}

function openDatabase(dbPath, readOnly) {
  // Database(databasePath, bufferManagerSize=0, enableCompression=true, readOnly=false, maxDBSize=0)
  const db = new kuzu.Database(dbPath, 0, true, !!readOnly, 0);
  const conn = new kuzu.Connection(db);
  return { db, conn };
}

// Run a query and normalize to { columns, rows }. connection.query() may resolve
// to a single QueryResult or an array (multiple statements) — keep the last.
async function runQuery(statement) {
  let res = await state.conn.query(statement);
  if (Array.isArray(res)) {
    const all = res;
    res = all[all.length - 1];
    // Close the earlier results we are discarding.
    for (let i = 0; i < all.length - 1; i++) {
      try { all[i].close(); } catch (_) { /* ignore */ }
    }
  }
  try {
    const columns = await res.getColumnNames();
    const rows = await res.getAll();
    return { columns, rows };
  } finally {
    try { res.close(); } catch (_) { /* ignore */ }
  }
}

function stripInternal(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue;
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  if ("id" in out) {
    out.db_id = out.id;
    delete out.id;
  }
  return out;
}

// Cytoscape treats these data keys structurally (a stray `parent` makes it a
// compound child, `source`/`target` rewire edges), so user properties with
// these names are renamed with a db_ prefix before being sent to the graph.
const CY_RESERVED = ["parent", "source", "target"];
function graphProps(obj) {
  const out = stripInternal(obj);
  for (const k of CY_RESERVED) {
    if (k in out) {
      out[`db_${k}`] = out[k];
      delete out[k];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

const methods = {
  async ping() {
    return { pong: true, kuzuVersion: kuzu ? kuzu.VERSION : null };
  },

  async connect({ path: dbPath, readOnly = true }) {
    if (!kuzu) {
      throw new Error(
        "Failed to load the 'kuzu' native module in the worker. " +
        "Run `npm install` in the extension folder."
      );
    }
    if (!dbPath || !fs.existsSync(dbPath)) {
      throw new Error("Database path does not exist.");
    }
    await releaseDb();
    try {
      const { db, conn } = openDatabase(dbPath, readOnly);
      // Force initialization now so lock errors surface here, not on first query.
      await conn.query("RETURN 1");
      state.db = db;
      state.conn = conn;
      state.path = dbPath;
      state.readOnly = !!readOnly;
      const mode = readOnly ? "read-only" : "read-write";
      return {
        message: `Connected to ${dbPath} (${mode})`,
        readOnly: !!readOnly,
        tempCopy: false,
        path: dbPath,
      };
    } catch (e) {
      await releaseDb();
      if (readOnly && isLockError(e)) {
        // Fall back to a snapshot copy.
        let tempRoot, openPath;
        try {
          ({ tempRoot, openPath } = copyDbForReadonly(dbPath));
        } catch (copyErr) {
          throw new Error(
            `DB is locked by another process and the snapshot fallback failed: ${copyErr.message || copyErr}`
          );
        }
        try {
          const { db, conn } = openDatabase(openPath, true);
          await conn.query("RETURN 1");
          state.db = db;
          state.conn = conn;
          state.path = dbPath;
          state.readOnly = true;
          state.tempDir = tempRoot;
          return {
            message: `Connected to a temp snapshot of ${dbPath} (original was locked by another process). Read-only.`,
            readOnly: true,
            tempCopy: true,
            path: dbPath,
          };
        } catch (inner) {
          try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
          await releaseDb();
          throw new Error(`Failed to open temp snapshot of locked DB: ${inner.message || inner}`);
        }
      }
      throw e;
    }
  },

  async disconnect() {
    const p = state.path;
    await releaseDb();
    return { message: p ? `Released ${p}` : "Already disconnected." };
  },

  async status() {
    return {
      connected: state.db !== null,
      path: state.path,
      readOnly: state.readOnly,
    };
  },

  async schema() {
    if (!state.conn) throw new Error("Database not connected.");
    const tables = await runQuery("CALL SHOW_TABLES() RETURN *");
    const schema = [];
    for (const row of tables.rows) {
      const tableName = row.name;
      const tableType = row.type;
      const info = await runQuery(`CALL TABLE_INFO('${tableName}') RETURN *`);
      const properties = info.rows.map((p) => ({
        propertyId: p["property id"] ?? p.id ?? null,
        name: p.name,
        type: p.type,
        primaryKey: p["primary key"] ?? false,
      }));
      schema.push({ name: tableName, type: tableType, properties });
    }
    return { schema };
  },

  async table({ name, limit = 100 }) {
    if (!state.conn) throw new Error("Database not connected.");
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
    }
    // Decide node vs rel from SHOW_TABLES.
    const tables = await runQuery("CALL SHOW_TABLES() RETURN *");
    let isNode = true;
    for (const row of tables.rows) {
      if (row.name === name && row.type === "REL") { isNode = false; break; }
    }
    const cypher = isNode
      ? `MATCH (n:\`${name}\`) RETURN n LIMIT ${Number(limit) | 0}`
      : `MATCH ()-[n:\`${name}\`]->() RETURN n LIMIT ${Number(limit) | 0}`;
    const res = await runQuery(cypher);
    // res.rows is [{ n: <object> }, ...]; flatten to the inner objects.
    const objects = res.rows.map((r) => r.n);
    const columnSet = new Set();
    const rows = objects.map((o) => {
      const clean = stripInternal(o);
      Object.keys(clean).forEach((k) => columnSet.add(k));
      return clean;
    });
    return { columns: Array.from(columnSet), rows, kind: isNode ? "NODE" : "REL" };
  },

  async query({ query }) {
    if (!state.conn) throw new Error("Database not connected.");
    if (state.readOnly && isWriteQuery(query)) {
      throw new Error(
        "Database is connected in read-only mode. Reconnect with read-only disabled to run write queries."
      );
    }
    const { columns, rows } = await runQuery(query);
    return { columns, rows };
  },

  async graph({ limit = 500 } = {}) {
    if (!state.conn) throw new Error("Database not connected.");
    const lim = Number(limit) | 0;
    const tables = await runQuery("CALL SHOW_TABLES() RETURN *");
    const nodeTables = [];
    const relTables = [];
    for (const row of tables.rows) {
      if (row.type === "NODE") nodeTables.push(row.name);
      else if (row.type === "REL") relTables.push(row.name);
    }

    const nodes = [];
    const edges = [];
    const nodeIds = new Set();

    // Assign each node table a distinct color, by order.
    const typeColors = {};
    nodeTables.forEach((t, i) => {
      typeColors[t] = TYPE_PALETTE[i % TYPE_PALETTE.length];
    });

    for (const nt of nodeTables) {
      const res = await runQuery(`MATCH (n:\`${nt}\`) RETURN n LIMIT ${lim}`);
      for (const r of res.rows) {
        const n = r.n;
        const idStr = formatId(n._id);
        if (idStr && !nodeIds.has(idStr)) {
          nodeIds.add(idStr);
          const type = n._label || nt;
          const props = graphProps(n);
          nodes.push({
            data: {
              id: idStr,
              ...props,
              type,
              color: typeColors[type] || TYPE_PALETTE[0],
              label: pickLabel(props, type),
            },
          });
        }
      }
    }

    for (const rt of relTables) {
      const res = await runQuery(`MATCH (a)-[r:\`${rt}\`]->(b) RETURN r LIMIT ${lim}`);
      for (const row of res.rows) {
        const r = row.r;
        const src = formatId(r._src);
        const dst = formatId(r._dst);
        const idStr = formatId(r._id);
        // Cytoscape rejects edges whose endpoints are not in the node set.
        if (src && dst && nodeIds.has(src) && nodeIds.has(dst)) {
          edges.push({
            data: { ...graphProps(r), id: idStr, source: src, target: dst, label: r._label || rt },
          });
        }
      }
    }

    return { nodes, edges };
  },
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (_) {
    return; // ignore non-protocol noise on stdin
  }
  if (typeof req !== "object" || req === null || typeof req.id === "undefined") {
    return;
  }
  const handler = methods[req.method];
  if (!handler) {
    send({ id: req.id, ok: false, error: `Unknown method: ${req.method}` });
    return;
  }
  try {
    const result = await handler(req.params || {});
    send({ id: req.id, ok: true, result });
  } catch (e) {
    send({ id: req.id, ok: false, error: e && e.message ? e.message : String(e) });
  }
});

rl.on("close", async () => {
  await releaseDb();
  process.exit(0);
});

process.on("SIGTERM", async () => { await releaseDb(); process.exit(0); });
process.on("SIGINT", async () => { await releaseDb(); process.exit(0); });

// Announce readiness on stderr (not part of the protocol).
log("worker ready, kuzu " + (kuzu ? kuzu.VERSION : "NOT LOADED"));
