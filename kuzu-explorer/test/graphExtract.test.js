"use strict";
/*
 * Unit tests for the Kuzu entity -> Cytoscape element conversion.
 * Run with: npm test   (node --test)
 *
 * The fixtures below mirror what Kuzu 0.11.3's Node binding actually returns
 * (verified against a real database):
 *   node         { <props>, _label, _id: { table, offset } }
 *   relationship { <props>, _label, _id, _src, _dst }
 *   path         { _nodes: [node, ...], _rels: [relationship, ...] }
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TYPE_PALETTE,
  formatId,
  colorMapFor,
  nodeEntry,
  edgeEntry,
  graphFromRows,
} = require("../worker/graphExtract");

const keanu = { name: "Keanu", age: 60, _label: "Person", _id: { offset: 0, table: 0 } };
const carrie = { name: "Carrie", age: 58, _label: "Person", _id: { offset: 1, table: 0 } };
const matrix = { title: "The Matrix", _label: "Movie", _id: { offset: 0, table: 1 } };
const relKeanu = {
  role: "Neo",
  _label: "ACTED_IN",
  _src: { offset: 0, table: 0 },
  _dst: { offset: 0, table: 1 },
  _id: { offset: 0, table: 2 },
};
const relCarrie = {
  role: "Trinity",
  _label: "ACTED_IN",
  _src: { offset: 1, table: 0 },
  _dst: { offset: 0, table: 1 },
  _id: { offset: 1, table: 2 },
};

test("formatId", () => {
  assert.equal(formatId({ table: 3, offset: 12 }), "3_12");
  assert.equal(formatId(null), null);
  assert.equal(formatId(undefined), null);
});

test("nodeEntry produces the element shape Cytoscape expects", () => {
  const colors = colorMapFor(["Person", "Movie"]);
  assert.deepEqual(nodeEntry(keanu, "Person", colors), {
    data: {
      id: "0_0",
      name: "Keanu",
      age: 60,
      type: "Person",
      color: TYPE_PALETTE[0],
      label: "Keanu",
    },
  });
  // Internal keys are stripped, `id` is renamed, and Cytoscape-reserved keys
  // are prefixed so they cannot rewire the graph.
  const tricky = {
    id: 7,
    source: "s",
    target: "t",
    parent: "p",
    _label: "Thing",
    _id: { offset: 4, table: 5 },
  };
  assert.deepEqual(nodeEntry(tricky, "Thing", {}), {
    data: {
      id: "5_4",
      db_id: 7,
      db_source: "s",
      db_target: "t",
      db_parent: "p",
      type: "Thing",
      color: TYPE_PALETTE[0],
      label: "7",
    },
  });
});

test("nodeEntry falls back to the table name when there is no usable label", () => {
  const blank = { x: "", _label: "Empty", _id: { offset: 0, table: 7 } };
  assert.equal(nodeEntry(blank, "Empty", {}).data.label, "Empty");
});

test("edgeEntry produces the element shape Cytoscape expects", () => {
  assert.deepEqual(edgeEntry(relKeanu, "ACTED_IN"), {
    data: {
      role: "Neo",
      id: "2_0",
      source: "0_0",
      target: "1_0",
      label: "ACTED_IN",
    },
  });
});

test("graphFromRows: RETURN s, r, x", () => {
  const g = graphFromRows([{ s: keanu, r: relKeanu, x: matrix }]);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.skippedEdges, 0);
  assert.deepEqual(
    g.nodes.map((n) => n.data.id).sort(),
    ["0_0", "1_0"]
  );
  assert.deepEqual(g.edges[0].data, {
    role: "Neo",
    id: "2_0",
    source: "0_0",
    target: "1_0",
    label: "ACTED_IN",
  });
  // Distinct colors per label, stable for the whole payload.
  const byType = {};
  g.nodes.forEach((n) => {
    byType[n.data.type] = n.data.color;
  });
  assert.equal(byType.Person, TYPE_PALETTE[0]);
  assert.equal(byType.Movie, TYPE_PALETTE[1]);
});

test("graphFromRows: entities repeated across rows are deduplicated", () => {
  const g = graphFromRows([
    { p: keanu, r: relKeanu, m: matrix },
    { p: carrie, r: relCarrie, m: matrix },
    { p: keanu, r: relKeanu, m: matrix },
  ]);
  assert.equal(g.nodes.length, 3); // keanu, carrie, matrix
  assert.equal(g.edges.length, 2); // relKeanu, relCarrie
});

test("graphFromRows: RETURN p (path) unwraps _nodes/_rels", () => {
  const path = { _nodes: [keanu, matrix], _rels: [relKeanu] };
  const g = graphFromRows([{ p: path }]);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].data.source, "0_0");
  assert.equal(g.edges[0].data.target, "1_0");
});

test("graphFromRows: arbitrarily nested containers (LIST of STRUCT, collect)", () => {
  const g = graphFromRows([
    { ps: [keanu, carrie] },
    { nested: [[matrix]] },
    { wrapped: { inner: { deeper: relKeanu } } },
  ]);
  assert.equal(g.nodes.length, 3);
  assert.equal(g.edges.length, 1);
});

test("graphFromRows: scalar-only results yield an empty graph", () => {
  const g = graphFromRows([
    { n: "Keanu", c: 1n },
    { n: "Carrie", c: 1n },
  ]);
  assert.deepEqual(g, { nodes: [], edges: [], skippedEdges: 0 });
});

test("graphFromRows: a bare id(n) object is not mistaken for a node", () => {
  // id(n) returns { table, offset } with no _id — it identifies a node but is
  // not one, and has no properties to draw.
  const g = graphFromRows([{ i: { offset: 0, table: 0 } }]);
  assert.deepEqual(g, { nodes: [], edges: [], skippedEdges: 0 });
});

test("graphFromRows: relationships without both endpoints are counted, not drawn", () => {
  const g = graphFromRows([{ r: relKeanu }]);
  assert.equal(g.nodes.length, 0);
  assert.equal(g.edges.length, 0);
  assert.equal(g.skippedEdges, 1);

  const partial = graphFromRows([{ p: keanu, r: relKeanu }]); // movie missing
  assert.equal(partial.nodes.length, 1);
  assert.equal(partial.edges.length, 0);
  assert.equal(partial.skippedEdges, 1);
});

test("graphFromRows: tolerates null, undefined, empty and cyclic input", () => {
  assert.deepEqual(graphFromRows([]), { nodes: [], edges: [], skippedEdges: 0 });
  assert.deepEqual(graphFromRows(undefined), { nodes: [], edges: [], skippedEdges: 0 });
  assert.deepEqual(graphFromRows([null, undefined, 1, "x"]), {
    nodes: [],
    edges: [],
    skippedEdges: 0,
  });

  const cyclic = { child: null, node: keanu };
  cyclic.child = cyclic; // would recurse forever without the visited set
  const g = graphFromRows([{ c: cyclic }]);
  assert.equal(g.nodes.length, 1);
});
