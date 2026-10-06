"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "worker", "dbWorker.js");

function kuzuAvailable() {
  try {
    require("kuzu");
    return true;
  } catch {
    return false;
  }
}

function createMovieDb(dbPath) {
  const script = `
    const kuzu = require("kuzu");
    const db = new kuzu.Database(${JSON.stringify(dbPath)});
    const conn = new kuzu.Connection(db);
    (async () => {
      await conn.query("CREATE NODE TABLE Person(name STRING, PRIMARY KEY(name))");
      await conn.query("CREATE NODE TABLE Movie(title STRING, PRIMARY KEY(title))");
      await conn.query("CREATE REL TABLE ACTED_IN(FROM Person TO Movie, role STRING)");
      await conn.query("CREATE (:Person {name:'Alice'}), (:Person {name:'Bob'})");
      await conn.query("CREATE (:Movie {title:'Graph Movie'})");
      await conn.query(
        "MATCH (p:Person), (m:Movie) CREATE (p)-[:ACTED_IN {role:p.name}]->(m)"
      );
      process.exit(0);
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `database setup failed with ${result.status}`);
  }
}

function startWorker() {
  const proc = spawn(process.execPath, [WORKER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
  });

  return {
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
        // best effort
      }
      proc.kill();
    },
  };
}

test(
  "worker query returns a drawable subgraph without rescanning the database",
  { skip: kuzuAvailable() ? false : "kuzu native addon is unavailable" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuzu-query-graph-"));
    const dbPath = path.join(dir, "movies.kuzu");
    createMovieDb(dbPath);

    const worker = startWorker();
    t.after(() => {
      worker.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const connected = await worker.call("connect", { path: dbPath, readOnly: true });
    assert.equal(connected.readOnly, true);

    const result = await worker.call("query", {
      query: "MATCH (p:Person)-[r:ACTED_IN]->(m:Movie) RETURN p, r, m",
    });
    assert.equal(result.rows.length, 2);
    assert.equal(result.graph.nodes.length, 3);
    assert.equal(result.graph.edges.length, 2);
    assert.equal(result.graph.skippedEdges, 0);

    const pathResult = await worker.call("query", {
      query: "MATCH p=(a:Person)-[r:ACTED_IN]->(m:Movie) RETURN p LIMIT 1",
    });
    assert.equal(pathResult.graph.nodes.length, 2);
    assert.equal(pathResult.graph.edges.length, 1);

    const scalar = await worker.call("query", {
      query: "MATCH (p:Person) RETURN p.name AS name",
    });
    assert.deepEqual(scalar.graph, { nodes: [], edges: [], skippedEdges: 0 });

    const relOnly = await worker.call("query", {
      query: "MATCH ()-[r:ACTED_IN]->() RETURN r",
    });
    assert.equal(relOnly.graph.nodes.length, 0);
    assert.equal(relOnly.graph.edges.length, 0);
    assert.equal(relOnly.graph.skippedEdges, 2);

    await worker.call("disconnect");
  }
);
