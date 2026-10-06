"use strict";
/*
 * Integration test for the database worker: spawns the real worker process,
 * connects it to a real Kuzu database and checks the JSON-RPC payloads.
 *
 * This is the path the extension actually uses, so it covers both the whole
 * database graph() and the new per-query graph payload end to end.
 *
 * Skipped automatically when Kuzu's native addon is not installed
 * (`npm install` runs its install script to fetch it).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const { createMovieDb, kuzuAvailable, EXTENSION_ROOT } = require("./kuzudb");

const WORKER = path.join(EXTENSION_ROOT, "worker", "dbWorker.js");
const skipReason = kuzuAvailable() ? false : "kuzu native addon is not installed";

/** Minimal JSON-RPC client for the worker's stdin/stdout protocol. */
function startWorker() {
  const proc = spawn(process.execPath, [WORKER], {
    cwd: EXTENSION_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // stderr-like noise on stdout
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  });
  return {
    proc,
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    stop() {
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      proc.kill();
    },
  };
}

test(
  "worker: query results carry an extracted subgraph",
  { skip: skipReason },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuzu-explorer-test-"));
    let worker;
    t.after(() => {
      if (worker) worker.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const dbPath = createMovieDb(path.join(dir, "movies.kuzu"));
    worker = startWorker();

    const ping = await worker.call("ping");
    assert.equal(ping.pong, true);
    assert.ok(ping.engines.kuzu, "kuzu engine did not load in the worker");

    const connected = await worker.call("connect", { path: dbPath, readOnly: true });
    assert.equal(connected.readOnly, true);

    // ---- the new bit: entities returned by a query -------------------------
    const res = await worker.call("query", {
      query: "MATCH (p:Person)-[r:ACTED_IN]->(m:Movie) RETURN p, r, m",
    });
    assert.deepEqual(res.columns, ["p", "r", "m"]);
    assert.equal(res.rows.length, 2);
    assert.equal(res.graph.nodes.length, 3, "expected Keanu + Carrie + The Matrix");
    assert.equal(res.graph.edges.length, 2);
    assert.equal(res.graph.skippedEdges, 0);
    const labels = res.graph.nodes.map((n) => n.data.label).sort();
    assert.deepEqual(labels, ["Carrie", "Keanu", "The Matrix"]);
    const movie = res.graph.nodes.find((n) => n.data.type === "Movie");
    assert.ok(movie.data.color, "nodes must carry a color for Cytoscape");
    for (const edge of res.graph.edges) {
      assert.equal(edge.data.label, "ACTED_IN");
      assert.equal(edge.data.target, movie.data.id);
      assert.ok(
        res.graph.nodes.some((n) => n.data.id === edge.data.source),
        "every edge endpoint must be a returned node"
      );
    }

    // ---- RETURN p (a whole path) -------------------------------------------
    const pathRes = await worker.call("query", {
      query: "MATCH p = (a:Person)-[r:ACTED_IN]->(m:Movie) RETURN p LIMIT 1",
    });
    assert.equal(pathRes.graph.nodes.length, 2);
    assert.equal(pathRes.graph.edges.length, 1);

    // ---- scalars only -------------------------------------------------------
    const scalar = await worker.call("query", {
      query: "MATCH (n:Person) RETURN n.name AS name, count(*) AS c",
    });
    assert.deepEqual(scalar.graph, { nodes: [], edges: [], skippedEdges: 0 });

    // ---- relationships whose endpoints were not returned ---------------------
    const relOnly = await worker.call("query", {
      query: "MATCH ()-[r:ACTED_IN]->() RETURN r",
    });
    assert.equal(relOnly.graph.nodes.length, 0);
    assert.equal(relOnly.graph.edges.length, 0);
    assert.equal(relOnly.graph.skippedEdges, 2);

    // ---- regression: the whole-database graph is unchanged ------------------
    const whole = await worker.call("graph", { limit: 10 });
    assert.equal(whole.nodes.length, 3);
    assert.equal(whole.edges.length, 2);
    assert.deepEqual(whole.truncated, []);
    assert.equal(whole.limit, 10);
    assert.deepEqual(
      whole.nodes.map((n) => n.data.label).sort(),
      ["Carrie", "Keanu", "The Matrix"]
    );

    // ---- regression: table browsing still strips internal keys --------------
    const table = await worker.call("table", { name: "Person", limit: 5 });
    assert.equal(table.kind, "NODE");
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.columns.sort(), ["age", "name"]);

    // ---- regression: the read-only write guard still fires -------------------
    await assert.rejects(
      worker.call("query", { query: "CREATE (:Person {name:'Hugo'})" }),
      /read-only/i
    );

    await worker.call("disconnect");
  }
);

test(
  "worker: a multi-hop chain query yields just that chain",
  { skip: skipReason },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuzu-explorer-test-"));
    const dbPath = path.join(dir, "code.kuzu");
    let worker;
    t.after(() => {
      if (worker) worker.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // A source-code-shaped schema: the point is that the query result is a tiny
    // chain while the database around it is not.
    const script = `
      const kuzu = require('kuzu');
      const db = new kuzu.Database(${JSON.stringify(dbPath)});
      const conn = new kuzu.Connection(db);
      const run = (s) => conn.query(s);
      (async () => {
        await run("CREATE NODE TABLE Symbol(name STRING, kind STRING, PRIMARY KEY(name))");
        await run("CREATE NODE TABLE SourceDeclaration(signature STRING, PRIMARY KEY(signature))");
        await run("CREATE NODE TABLE SourceFile(path STRING, PRIMARY KEY(path))");
        await run("CREATE NODE TABLE Assembly(name STRING, PRIMARY KEY(name))");
        await run("CREATE REL TABLE HAS_DECLARATION(FROM Symbol TO SourceDeclaration)");
        await run("CREATE REL TABLE DECLARED_IN(FROM SourceDeclaration TO SourceFile)");
        await run("CREATE REL TABLE REFERENCES(FROM Assembly TO Symbol)");
        await run("CREATE (:Symbol {name:'Save', kind:'method'}), (:Symbol {name:'Load', kind:'method'})");
        await run("CREATE (:SourceDeclaration {signature:'void Save()'})");
        await run("CREATE (:SourceDeclaration {signature:'void Load()'})");
        await run("CREATE (:SourceFile {path:'src/io.cpp'}), (:SourceFile {path:'src/net.cpp'})");
        await run("CREATE (:Assembly {name:'Core'})");
        await run("MATCH (s:Symbol), (d:SourceDeclaration) " +
                  "WHERE (s.name = 'Save' AND d.signature = 'void Save()') " +
                  "   OR (s.name = 'Load' AND d.signature = 'void Load()') " +
                  "CREATE (s)-[:HAS_DECLARATION]->(d)");
        await run("MATCH (d:SourceDeclaration), (f:SourceFile) " +
                  "WHERE (d.signature = 'void Save()' AND f.path = 'src/io.cpp') " +
                  "   OR (d.signature = 'void Load()' AND f.path = 'src/net.cpp') " +
                  "CREATE (d)-[:DECLARED_IN]->(f)");
        await run("MATCH (a:Assembly), (s:Symbol) CREATE (a)-[:REFERENCES]->(s)");
      })();
    `;
    const built = spawnSync(process.execPath, ["-e", script], {
      cwd: EXTENSION_ROOT,
      encoding: "utf8",
    });
    assert.equal(built.status, 0, built.stderr);

    worker = startWorker();
    await worker.call("connect", { path: dbPath, readOnly: true });

    const res = await worker.call("query", {
      query:
        "MATCH (s:Symbol)-[hd:HAS_DECLARATION]->(d:SourceDeclaration)-[di:DECLARED_IN]->(f:SourceFile) " +
        "WHERE s.kind = 'method' AND s.name = 'Save' " +
        "RETURN s, hd, d, di, f LIMIT 30",
    });
    assert.equal(res.rows.length, 1);
    assert.deepEqual(
      res.graph.nodes.map((n) => n.data.label).sort(),
      ["Save", "src/io.cpp", "void Save()"]
    );
    assert.deepEqual(
      res.graph.edges.map((e) => e.data.label).sort(),
      ["DECLARED_IN", "HAS_DECLARATION"]
    );
    assert.equal(res.graph.skippedEdges, 0);
    // The chain is connected end to end.
    const byId = {};
    res.graph.nodes.forEach((n) => {
      byId[n.data.id] = n.data.label;
    });
    const [first, second] = res.graph.edges;
    assert.equal(first.data.target, second.data.source, "the two hops must share a node");
    assert.ok(byId[first.data.source] && byId[second.data.target]);

    // ...while the whole-database view would have dragged everything else in.
    const whole = await worker.call("graph", { limit: 2000 });
    assert.ok(whole.nodes.length > res.graph.nodes.length);
    assert.ok(whole.edges.length > res.graph.edges.length);
  }
);
