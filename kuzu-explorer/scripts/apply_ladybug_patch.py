#!/usr/bin/env python3
"""Apply the dual-engine patch to kuzu-explorer/worker/dbWorker.js in one pass.

Idempotent: skips any hunk whose anchor is absent (already applied).
Run from the kuzu-explorer/ directory.
"""
import sys

path = "worker/dbWorker.js"
w = open(path).read()
applied = []

# 1. engine table + magic detection, after the readline require
H1_OLD = 'const readline = require("readline");\n'
H1_NEW = '''const readline = require("readline");

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
'''
if H1_NEW.strip().split("\n")[2] not in w:
    assert H1_OLD in w, "H1 anchor missing"
    w = w.replace(H1_OLD, H1_NEW, 1)
    applied.append("engine table + magic detection")

# 2. remove the old single-engine require block
H2_OLD = '''let kuzu;
try {
  kuzu = require("kuzu");
} catch (e) {
  // Report the load failure on the first request rather than crashing silently.
  kuzu = null;
}

'''
if H2_OLD in w:
    w = w.replace(H2_OLD, "", 1)
    applied.append("removed single-engine require block")

# 3. connect guard
H3_OLD = '''    if (!kuzu) {
      throw new Error(
        "Failed to load the 'kuzu' native module in the worker. " +
        "Run `npm install` in the extension folder."
      );
    }'''
H3_NEW = '''    if (!ENGINES.kuzu && !ENGINES.ladybug) {
      throw new Error(
        "Failed to load either graph engine in the worker. " +
        "Run `npm install` in the extension folder."
      );
    }'''
if H3_OLD in w:
    w = w.replace(H3_OLD, H3_NEW, 1)
    applied.append("connect guard -> engine table")

# 4. openDatabase: pick engine per file
H4_OLD = '''function openDatabase(dbPath, readOnly) {
  // Database(databasePath, bufferManagerSize=0, enableCompression=true, readOnly=false, maxDBSize=0)
  const db = new kuzu.Database(dbPath, 0, true, !!readOnly, 0);
  const conn = new kuzu.Connection(db);
  return { db, conn };
}'''
H4_NEW = '''function openDatabase(dbPath, readOnly) {
  // Database(databasePath, bufferManagerSize=0, enableCompression=true, readOnly=false, maxDBSize=0)
  const { mod, version, format } = engineFor(dbPath);
  const db = new mod.Database(dbPath, 0, true, !!readOnly, 0);
  const conn = new mod.Connection(db);
  return { db, conn, engine: { format, version } };
}'''
if H4_OLD in w:
    w = w.replace(H4_OLD, H4_NEW, 1)
    applied.append("openDatabase -> engineFor()")

# 5. state gains engine fields
H5_OLD = '''  readOnly: false,
  tempDir: null,
};'''
H5_NEW = '''  readOnly: false,
  tempDir: null,
  engine: null,
  engineVersion: null,
};'''
if H5_NEW not in w and H5_OLD in w:
    w = w.replace(H5_OLD, H5_NEW, 1)
    applied.append("state + engine fields")

# 6. connect success: destructure engine, record, report
H6_OLD = '''      const { db, conn } = openDatabase(dbPath, readOnly);
      // Force initialization now so lock errors surface here, not on first query.
      await conn.query("RETURN 1");
      state.db = db;
      state.conn = conn;
      state.path = dbPath;
      state.readOnly = !!readOnly;
      const mode = readOnly ? "read-only" : "read-write";
      return {
        message: `Connected to ${dbPath} (${mode})`,'''
H6_NEW = '''      const { db, conn, engine } = openDatabase(dbPath, readOnly);
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
        message: `Connected to ${dbPath} (${mode}, ${engine.format} ${engine.version})`,'''
if H6_OLD in w:
    w = w.replace(H6_OLD, H6_NEW, 1)
    applied.append("connect success names engine")

# 7. ping reports both engines
H7_OLD = '''  async ping() {
    return { pong: true, kuzuVersion: kuzu ? kuzu.VERSION : null };
  },'''
H7_NEW = '''  async ping() {
    return {
      pong: true,
      engines: Object.fromEntries(
        Object.entries(ENGINES).map(([k, m]) => [k, m ? m.VERSION : null])
      ),
    };
  },'''
if H7_OLD in w:
    w = w.replace(H7_OLD, H7_NEW, 1)
    applied.append("ping reports both engines")

# 8. ready log
H8_OLD = '''log("worker ready, kuzu " + (kuzu ? kuzu.VERSION : "NOT LOADED"));'''
H8_NEW = '''log(
  "worker ready; engines: kuzu " +
    (ENGINES.kuzu ? ENGINES.kuzu.VERSION : "NOT LOADED") +
    ", ladybug " +
    (ENGINES.ladybug ? ENGINES.ladybug.VERSION : "NOT LOADED")
);'''
if H8_OLD in w:
    w = w.replace(H8_OLD, H8_NEW, 1)
    applied.append("ready log dual-engine")

# 9. readonly snapshot copy: recognise .ladybug siblings
H9_OLD = '''    const stem = base.endsWith(".kuzu") ? base.slice(0, -".kuzu".length) : base;'''
H9_NEW = '''    const stem = [".kuzu", ".kuzudb", ".ladybug"].find((sfx) =>
      base.endsWith(sfx)
    )
      ? base.slice(0, base.lastIndexOf("."))
      : base;'''
if H9_OLD in w:
    w = w.replace(H9_OLD, H9_NEW, 1)
    applied.append("snapshot copy accepts .ladybug siblings")

if not applied:
    print("nothing to apply (already patched)")
else:
    open(path, "w").write(w)
    print(f"applied {len(applied)} hunks:")
    for a in applied:
        print(f"  - {a}")

if "kuzu = null" in open(path).read():
    sys.exit("WARNING: something reintroduced a bare `kuzu` reference")
print("no bare `kuzu` global references remain")
