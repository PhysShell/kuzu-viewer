"use strict";

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

const alice = { name: "Alice", _label: "Person", _id: { table: 0, offset: 0 } };
const bob = { name: "Bob", _label: "Person", _id: { table: 0, offset: 1 } };
const movie = { title: "Graph Movie", _label: "Movie", _id: { table: 1, offset: 0 } };
const acted = {
  role: "Lead",
  _label: "ACTED_IN",
  _id: { table: 2, offset: 0 },
  _src: { table: 0, offset: 0 },
  _dst: { table: 1, offset: 0 },
};

test("formatId and Cytoscape conversion", () => {
  assert.equal(formatId({ table: 3, offset: 12 }), "3_12");

  const colors = colorMapFor(["Person", "Movie"]);
  assert.equal(nodeEntry(alice, "Person", colors).data.color, TYPE_PALETTE[0]);
  assert.deepEqual(edgeEntry(acted, "ACTED_IN").data, {
    role: "Lead",
    id: "2_0",
    source: "0_0",
    target: "1_0",
    label: "ACTED_IN",
  });
});

test("graphFromRows extracts RETURN node, rel, node", () => {
  const graph = graphFromRows([{ a: alice, r: acted, m: movie }]);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.skippedEdges, 0);
  assert.deepEqual(
    graph.nodes.map((n) => n.data.label).sort(),
    ["Alice", "Graph Movie"]
  );
});

test("graphFromRows unwraps paths and nested containers", () => {
  const path = { _nodes: [alice, movie], _rels: [acted] };
  const graph = graphFromRows([
    { p: path },
    { nested: [[bob]] },
    { again: { inner: alice } },
  ]);

  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 1);
});

test("graphFromRows deduplicates repeated entities", () => {
  const graph = graphFromRows([
    { a: alice, r: acted, m: movie },
    { a: alice, r: acted, m: movie },
  ]);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
});

test("scalar-only results are not treated as graph entities", () => {
  assert.deepEqual(graphFromRows([{ name: "Alice", count: 1n }]), {
    nodes: [],
    edges: [],
    skippedEdges: 0,
  });
});

test("relationship-only results report skipped endpoints", () => {
  const graph = graphFromRows([{ r: acted }]);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.skippedEdges, 1);
});

test("reserved Cytoscape property names are preserved safely", () => {
  const tricky = {
    id: "domain-id",
    source: "domain-source",
    target: "domain-target",
    parent: "domain-parent",
    _label: "Thing",
    _id: { table: 5, offset: 4 },
  };
  const node = nodeEntry(tricky, "Thing", {});
  assert.equal(node.data.db_id, "domain-id");
  assert.equal(node.data.db_source, "domain-source");
  assert.equal(node.data.db_target, "domain-target");
  assert.equal(node.data.db_parent, "domain-parent");
  assert.equal(node.data.id, "5_4");
});
