"use strict";
/*
 * Activation-level test: runs the real extension entry point against a stubbed
 * `vscode` API, connects to a real Kuzu database through the real worker, runs a
 * Cypher query and drives the "Visualize result" command.
 *
 * This is the whole feature in one go:
 *   activate -> connect -> query -> extract (worker) -> Visualize result ->
 *   pinned payload handed to the graph panel.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { installVscodeStub, vscodeStub, panels } = require("./fakeDom");
const { createMovieDb, kuzuAvailable, EXTENSION_ROOT } = require("./kuzudb");

const restore = installVscodeStub();
const { activate } = require("../out/extension");

test.after(() => restore());

const skipReason = kuzuAvailable() ? false : "kuzu native addon is not installed";

function command(id) {
  const found = vscodeStub.commands.registered.find((c) => c.id === id);
  assert.ok(found, `command ${id} was not registered`);
  return found.fn;
}

async function waitFor(predicate, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test(
  "activation: the Visualize Last Query Result command draws the last result",
  { skip: skipReason },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuzu-explorer-act-"));
    const dbPath = createMovieDb(path.join(dir, "movies.kuzu"));
    // A real extension path: the worker is spawned from <extensionPath>/worker.
    const context = {
      subscriptions: [],
      extensionPath: EXTENSION_ROOT,
      extensionUri: { path: EXTENSION_ROOT, fsPath: EXTENSION_ROOT },
    };
    // Use this process's Node to run the worker, whatever is on PATH.
    vscodeStub.workspace.getConfiguration = () => ({
      get: (key, fallback) => (key === "nodePath" ? process.execPath : fallback),
    });
    t.after(() => {
      context.subscriptions.forEach((d) => {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      });
      while (panels.length) {
        panels.pop().dispose();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    activate(context);
    const visualize = command("kuzuExplorer.visualizeResult");

    // Not connected yet.
    await visualize();
    assert.deepEqual(vscodeStub.window.warningMessages, ["Kuzu: connect to a database first."]);

    // Connect to the real database (the connect command drives the worker).
    vscodeStub.window.showInputBox = async () => dbPath;
    vscodeStub.window.showQuickPick = async () => ({ label: "Read-only", ro: true });
    await command("kuzuExplorer.connect")();

    // Connected, but nothing has been queried yet.
    vscodeStub.window.informationMessages.length = 0;
    await visualize();
    assert.deepEqual(vscodeStub.window.informationMessages, [
      "Kuzu: run a query that returns nodes or relationships first.",
    ]);

    // Open the query panel and run a query through the real worker.
    await command("kuzuExplorer.runQuery")();
    const queryPanel = panels[0];
    assert.equal(queryPanel.viewType, "kuzuExplorer.query");
    for (const handler of queryPanel.webview.handlers) {
      await handler({
        type: "run",
        query: "MATCH (p:Person)-[r:ACTED_IN]->(m:Movie) RETURN p, r, m",
      });
    }
    const result = await waitFor(
      () => queryPanel.webview.posted.find((m) => m.type === "result"),
      "a query result"
    );
    assert.deepEqual(result.graph, { nodes: 3, edges: 2, skipped: 0 });

    // The command now has something to draw, and hands it to the graph panel.
    await visualize();
    assert.equal(panels.length, 2, "the graph panel should have been opened");
    const graphPanel = panels[1];
    assert.equal(graphPanel.viewType, "kuzuExplorer.graph");
    assert.equal(graphPanel.title, "Kuzu Graph — result (3 nodes, 2 edges)");

    const graphMsg = await waitFor(
      () => graphPanel.webview.posted.find((m) => m.type === "graph"),
      "the pinned graph payload"
    );
    assert.equal(graphMsg.pinned, true);
    assert.deepEqual(
      graphMsg.nodes.map((n) => n.data.label).sort(),
      ["Carrie", "Keanu", "The Matrix"]
    );
    assert.equal(graphMsg.edges.length, 2);
    assert.equal(graphMsg.skippedEdges, 0);
  }
);
