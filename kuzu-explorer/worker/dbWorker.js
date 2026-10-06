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

// Kuzu entity -> Cytoscape element conversion, shared by graph() and query().
const {
  stripInternal,
  formatId,
  colorMapFor,
  nodeEntry,
  edgeEntry,
  graphFromRows,
} = require("./graphExtract");

// Two engines, chosen PER FILE by its storage-format magic header:
//   "LBUG"  -> LadybugDB (@ladybugdb/core), the maintained successor
//   "KUZU"  -> Kuzu 0.11.x, for databases written by the original engine
// Both are bundled; neither is a fallback for the other. A file written by one
// is unreadable by the other ("not a valid ... database file"), so the header,
// not preference, decides.
const ENGINES = {};
function loadEngine(name, pkg) {
  if (ENGINES[name] !== undefined) return ENGINES[name];
  try {
    ENGINES[name] = require(pkg);
  } catch (e) {
    ENGINES[name] = null;
  }
  return ENGINES[name];
}
loadEngine("ladybug", "@ladybugdb/core");
loadEngine("kuzu", "kuzu");

// Peek the magic at the head of the DB file. Opening a file with the wrong
// engine fails at query time with a confusing "not a valid ... database file!",
// so we read the header ourselves and report a clear error instead.
function detectFormat(dbPath) {
  const fd = fs.openSync(dbPath, "r");
  try {
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    const magic = buf.toString("ascii", 0, 4);
    if (magic === "LBUG") return "ladybug";
    if (magic === "KUZU") return "kuzu";
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function engineFor(dbPath) {
  const fmt = detectFormat(dbPath);
  if (fmt === null) {
    throw new Error(
      `Unrecognised database format header in ${dbPath}. ` +
      `Supported: Kuzu (KUZU header) and LadybugDB (LBUG header).`
    );
  }
  const mod = ENGINES[fmt];
  if (!mod) {
    throw new Error(
      `This database is ${fmt === "ladybug" ? "LadybugDB" : "Kuzu"}-format but ` +
      `its engine module (${fmt === "ladybug" ? "@ladybugdb/core" : "kuzu"}) ` +
      `failed to load. Run \`npm install\` in the extension folder.`
    );
  }
  return { mod, version: mod.VERSION, format: fmt };
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
  engine: null,
  engineVersion: null,
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
    const stem = [".kuzu", ".kuzudb", ".ladybug"].find((sfx) =>
      base.endsWith(sfx)
    )
      ? base.slice(0, base.lastIndexOf("."))
      : base;
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
  const { mod, version, format } = engineFor(dbPath);
  const db = new mod.Database(dbPath, 0, true, !!readOnly, 0);
  const conn = new mod.Connection(db);
  return { db, conn, engine: { format, version } };
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

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

const methods = {
  async ping() {
    return {
      pong: true,
      engines: Object.fromEntries(
        Object.entries(ENGINES).map(([k, m]) => [k, m ? m.VERSION : null])
      ),
    };
  },

  async connect({ path: dbPath, readOnly = true }) {
    if (!ENGINES.kuzu && !ENGINES.ladybug) {
      throw new Error(
        "Failed to load either graph engine in the worker. " +
        "Run `npm install` in the extension folder."
      );
    }
    if (!dbPath || !fs.existsSync(dbPath)) {
      throw new Error("Database path does not exist.");
    }
    await releaseDb();
    try {
      const { db, conn, engine } = openDatabase(dbPath, readOnly);
      // Force initialization now so lock errors surface here, not on first query.
      await conn.query("RETURN 1");
      state.db = db;
      state.conn = conn;
      state.path = dbPath;
      state.readOnly = !!readOnly;
      state.engine = engine.format;
      state.engineVersion = engine.version;
      const mode = readOnly ? "read-only" : "read-write";
      return {
        message: `Connected to ${dbPath} (${mode}, ${engine.format} ${engine.version})`,
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
    // Extract the entities the query actually returned so the panel can offer a
    // "Visualize result" action without rescanning the database.
    return { columns, rows, graph: graphFromRows(rows) };
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
    // Tables whose rows hit the limit, so the graph is only a sample of them.
    const truncated = [];

    // Assign each node table a distinct color, by catalog order.
    const typeColors = colorMapFor(nodeTables);

    for (const nt of nodeTables) {
      const res = await runQuery(`MATCH (n:\`${nt}\`) RETURN n LIMIT ${lim}`);
      if (res.rows.length >= lim) truncated.push(nt);
      for (const r of res.rows) {
        const n = r.n;
        const idStr = formatId(n._id);
        if (idStr && !nodeIds.has(idStr)) {
          nodeIds.add(idStr);
          nodes.push(nodeEntry(n, nt, typeColors));
        }
      }
    }

    for (const rt of relTables) {
      const res = await runQuery(`MATCH (a)-[r:\`${rt}\`]->(b) RETURN r LIMIT ${lim}`);
      if (res.rows.length >= lim) truncated.push(rt);
      for (const row of res.rows) {
        const r = row.r;
        const src = formatId(r._src);
        const dst = formatId(r._dst);
        // Cytoscape rejects edges whose endpoints are not in the node set.
        if (src && dst && nodeIds.has(src) && nodeIds.has(dst)) {
          edges.push(edgeEntry(r, rt));
        }
      }
    }

    return { nodes, edges, truncated, limit: lim };
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
log(
  "worker ready; engines: kuzu " +
    (ENGINES.kuzu ? ENGINES.kuzu.VERSION : "NOT LOADED") +
    ", ladybug " +
    (ENGINES.ladybug ? ENGINES.ladybug.VERSION : "NOT LOADED")
);
