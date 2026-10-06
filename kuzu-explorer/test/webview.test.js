"use strict";
/*
 * Executes the two webview scripts and the panel classes that drive them, using
 * a minimal DOM and a stubbed `vscode` module. This covers the part of the
 * "Visualize result" feature that lives outside the worker:
 *
 *   query result -> button label/state -> visualize message -> GraphPanel ->
 *   pinned graph payload -> Cytoscape webview status line
 *
 * Cytoscape itself is the real library, run headless.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDom, inlineScript, installVscodeStub, panels } = require("./fakeDom");

const restore = installVscodeStub();
const cytoscapeFactory = require("cytoscape");

const { QueryPanel } = require("../out/panels/queryPanel");
const { GraphPanel } = require("../out/panels/graphPanel");

test.after(() => restore());

const EXTENSION_URI = { path: "/ext", fsPath: "/ext" };

const QUERY_IDS = ["q", "out", "status", "viz", "run"];
const GRAPH_IDS = ["status", "details", "cy", "side", "splitter", "groupBy", "toggleSide", "overlay", "reload", "fit"];

/** Run a webview's script and keep extension<->webview messages flowing. */
async function mount(panel, ids, extraGlobals = {}) {
  const dom = createDom(ids);
  Object.assign(dom.sandbox, extraGlobals);
  panel.webview.onPost = (msg) => dom.post(msg);
  dom.run(inlineScript(panel.webview.html));
  await pump(panel.webview, dom);
  return dom;
}

/** Shuttle messages until both sides go quiet. */
async function pump(webview, dom) {
  let delivered = 0;
  for (let i = 0; i < 20; i++) {
    while (delivered < dom.messages.length) {
      const msg = dom.messages[delivered++];
      for (const handler of webview.handlers) {
        await handler(msg);
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (delivered >= dom.messages.length) {
      return;
    }
  }
  throw new Error("message pump did not settle");
}

function fakeClient(result) {
  return {
    isConnected: true,
    databasePath: "/db/test.kuzu",
    readOnly: true,
    query: async () => result,
    table: async () => ({ columns: [], rows: [], kind: "NODE" }),
    graph: async () => ({ nodes: [], edges: [], truncated: [], limit: 2000 }),
  };
}

// A result shaped exactly like the worker's: rows plus an extracted subgraph.
const RESULT = {
  columns: ["s", "r", "x"],
  rows: [
    { s: { name: "Save" }, r: { role: "call" }, x: { name: "Store" } },
    { s: { name: "Save" }, r: { role: "call" }, x: { name: "Flush" } },
  ],
  graph: {
    nodes: [
      { data: { id: "0_0", name: "Save", type: "Symbol", color: "#4f8cc9", label: "Save" } },
      { data: { id: "1_0", name: "Store", type: "Symbol", color: "#4f8cc9", label: "Store" } },
      { data: { id: "1_1", name: "Flush", type: "File", color: "#e0a458", label: "Flush" } },
    ],
    edges: [
      { data: { id: "2_0", source: "0_0", target: "1_0", label: "CALLS", role: "call" } },
      { data: { id: "2_1", source: "0_0", target: "1_1", label: "CALLS", role: "call" } },
    ],
    skippedEdges: 0,
  },
};

function resetPanels() {
  while (panels.length) {
    panels.pop().dispose();
  }
}

test("Visualize result: button reflects the result, then pins the subgraph", async (t) => {
  resetPanels();
  t.after(resetPanels);

  const queryPanel = QueryPanel.show(fakeClient(RESULT), EXTENSION_URI);
  const queryDom = await mount(panels[0], QUERY_IDS);
  const vizBtn = queryDom.elements.viz;

  // Before any result: disabled, with a reason.
  assert.equal(vizBtn.disabled, true);
  assert.equal(vizBtn.textContent, "Visualize result");
  assert.match(vizBtn.title, /no graph entities/);

  await queryPanel.runQuery("MATCH (s:Symbol)-[r:CALLS]->(x) RETURN s, r, x");
  await pump(panels[0].webview, queryDom);

  assert.equal(vizBtn.disabled, false);
  assert.equal(vizBtn.textContent, "Visualize result (3 nodes, 2 edges)");

  // Clicking it opens the graph panel on exactly that payload.
  vizBtn.dispatch("click");
  await pump(panels[0].webview, queryDom);

  assert.equal(panels.length, 2, "expected the graph panel to be opened");
  const graphPanel = panels[1];
  assert.match(graphPanel.title, /result/);

  const graphDom = await mount(
    graphPanel,
    GRAPH_IDS,
    // Real Cytoscape, headless: the webview passes a DOM container, which the
    // canvas renderer would need, so the container is dropped here.
    { cytoscape: (opts) => cytoscapeFactory({ ...opts, container: undefined, headless: true }) }
  );

  const graphMsg = graphPanel.webview.posted.find((m) => m.type === "graph");
  assert.ok(graphMsg, "graph panel was never sent a graph payload");
  assert.equal(graphMsg.pinned, true);
  assert.equal(graphMsg.nodes.length, 3);
  assert.equal(graphMsg.edges.length, 2);

  // The webview drew it, marked it as a query result and hid Reload.
  assert.match(graphDom.elements.status.textContent, /^Query result: 3 nodes, 2 edges/);
  assert.equal(graphDom.elements.reload.style.display, "none");
});

test("Visualize result: scalar-only results disable the button", async (t) => {
  resetPanels();
  t.after(resetPanels);

  const scalar = {
    columns: ["name", "c"],
    rows: [{ name: "Save", c: 2 }],
    graph: { nodes: [], edges: [], skippedEdges: 0 },
  };
  const queryPanel = QueryPanel.show(fakeClient(scalar), EXTENSION_URI);
  const dom = await mount(panels[0], QUERY_IDS);

  await queryPanel.runQuery("MATCH (s:Symbol) RETURN s.name AS name, count(*) AS c");
  await pump(panels[0].webview, dom);

  assert.equal(dom.elements.viz.disabled, true);
  assert.match(dom.elements.viz.title, /returned no graph entities/);
  assert.equal(QueryPanel.visualizeLastResult(), false, "nothing to visualize");
  assert.equal(panels.length, 1, "no graph panel should have been opened");
});

test("Visualize result: relationships without endpoints are explained", async (t) => {
  resetPanels();
  t.after(resetPanels);

  // Only relationships returned: nothing drawable, but the user should be told
  // why instead of seeing a silently empty button.
  const relOnly = {
    columns: ["r"],
    rows: [{ r: { role: "call" } }],
    graph: { nodes: [], edges: [], skippedEdges: 2 },
  };
  const queryPanel = QueryPanel.show(fakeClient(relOnly), EXTENSION_URI);
  const dom = await mount(panels[0], QUERY_IDS);

  await queryPanel.runQuery("MATCH ()-[r:CALLS]->() RETURN r");
  await pump(panels[0].webview, dom);

  assert.equal(dom.elements.viz.disabled, true);
  assert.match(dom.elements.viz.title, /2 relationship\(s\) are missing an endpoint/);
});

test("graph webview: a pinned payload keeps working across a reload", async (t) => {
  resetPanels();
  t.after(resetPanels);

  const queryPanel = QueryPanel.show(fakeClient(RESULT), EXTENSION_URI);
  const queryDom = await mount(panels[0], QUERY_IDS);
  await queryPanel.runQuery("MATCH (s:Symbol)-[r:CALLS]->(x) RETURN s, r, x");
  await pump(panels[0].webview, queryDom);
  queryDom.elements.viz.dispatch("click");
  await pump(panels[0].webview, queryDom);

  const graphPanel = panels[1];
  const graphDom = await mount(
    graphPanel,
    GRAPH_IDS,
    { cytoscape: (opts) => cytoscapeFactory({ ...opts, container: undefined, headless: true }) }
  );

  // A hidden-then-restored webview asks for its content again with `ready`.
  const before = graphPanel.webview.posted.filter((m) => m.type === "graph").length;
  graphDom.post({ type: "ready" });
  await pump(graphPanel.webview, graphDom);
  const after = graphPanel.webview.posted.filter((m) => m.type === "graph").length;
  assert.equal(after, before + 1, "the pinned payload should be re-sent on ready");
  assert.match(graphDom.elements.status.textContent, /^Query result: 3 nodes, 2 edges/);
});

test("graph panel: Show Graph switches a pinned panel back to the database", async (t) => {
  resetPanels();
  t.after(resetPanels);

  const client = fakeClient(RESULT);
  const queryPanel = QueryPanel.show(client, EXTENSION_URI);
  const queryDom = await mount(panels[0], QUERY_IDS);
  await queryPanel.runQuery("MATCH (s:Symbol)-[r:CALLS]->(x) RETURN s, r, x");
  await pump(panels[0].webview, queryDom);
  queryDom.elements.viz.dispatch("click");
  await pump(panels[0].webview, queryDom);

  const graphPanel = panels[1];
  assert.match(graphPanel.title, /result/);

  GraphPanel.show(client, EXTENSION_URI);
  assert.equal(panels.length, 2, "the existing panel must be reused, not duplicated");
  assert.equal(graphPanel.title, "Kuzu Graph");
  assert.ok(
    graphPanel.webview.posted.some((m) => m.type === "reload"),
    "the database graph should be reloaded"
  );
});
