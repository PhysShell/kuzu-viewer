"use strict";
/*
 * Creates a small Kuzu database for the tests.
 *
 * The database is built in a child process: Kuzu 0.11.3's addon segfaults while
 * the process tears down once Database.close() has been called, which would take
 * the test runner with it. A child that simply exits flushes cleanly.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const EXTENSION_ROOT = path.join(__dirname, "..");

function createMovieDb(dbPath) {
  const script = `
    const kuzu = require('kuzu');
    const db = new kuzu.Database(${JSON.stringify(dbPath)});
    const conn = new kuzu.Connection(db);
    const run = (s) => conn.query(s);
    (async () => {
      await run("CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name))");
      await run("CREATE NODE TABLE Movie(title STRING, PRIMARY KEY(title))");
      await run("CREATE REL TABLE ACTED_IN(FROM Person TO Movie, role STRING)");
      await run("CREATE (:Person {name:'Keanu', age:60}), (:Person {name:'Carrie', age:58})");
      await run("CREATE (:Movie {title:'The Matrix'})");
      await run("MATCH (p:Person), (m:Movie) WHERE m.title = 'The Matrix' " +
                "CREATE (p)-[:ACTED_IN {role: p.name}]->(m)");
    })();
  `;
  const res = spawnSync(process.execPath, ["-e", script], {
    cwd: EXTENSION_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Could not create the test database: ${res.stderr || res.status}`);
  }
  return dbPath;
}

/** True when Kuzu's native addon can be loaded here. */
function kuzuAvailable() {
  try {
    require("kuzu");
    return true;
  } catch {
    return false;
  }
}

module.exports = { createMovieDb, kuzuAvailable, EXTENSION_ROOT };
