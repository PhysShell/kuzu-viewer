"use strict";
/*
 * graphExtract.js — turns Kuzu entities into Cytoscape elements.
 *
 * Kuzu's Node binding returns graph entities as plain objects:
 *
 *   node:         { <props>, _label, _id: { table, offset } }
 *   relationship: { <props>, _label, _id, _src: { table, offset }, _dst: { ... } }
 *   path:         { _nodes: [node, ...], _rels: [relationship, ...] }
 *
 * Node ids and rel-group ids come from the same table-id counter, so
 * "table_offset" is unique across nodes and edges and can be used as the
 * Cytoscape element id directly.
 *
 * Used by both graph-producing RPC methods so they emit identical shapes:
 *   graph()  — samples every node/rel table of the database
 *   query()  — extracts only the entities a query actually returned
 */

// Color palette; node types are assigned distinct colors by order.
const TYPE_PALETTE = [
  "#4f8cc9", "#e0a458", "#6cbf84", "#c96f9b",
  "#9b7fd1", "#d1786f", "#5bb3c9", "#b3a14f",
];

// Fallbacks when an entity carries no _label (should not happen with 0.11.x).
const UNKNOWN_NODE_TYPE = "node";
const UNKNOWN_REL_LABEL = "rel";

function formatId(idObj) {
  if (!idObj) return null;
  return `${idObj.table}_${idObj.offset}`;
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

/** Assign each type a distinct palette color, in the given order. */
function colorMapFor(types) {
  const colors = {};
  types.forEach((t, i) => {
    colors[t] = TYPE_PALETTE[i % TYPE_PALETTE.length];
  });
  return colors;
}

/** One Cytoscape node element from a Kuzu node object. */
function nodeEntry(raw, fallbackType, typeColors) {
  const type = raw._label || fallbackType;
  const props = graphProps(raw);
  return {
    data: {
      id: formatId(raw._id),
      ...props,
      type,
      color: typeColors[type] || TYPE_PALETTE[0],
      label: pickLabel(props, type),
    },
  };
}

/** One Cytoscape edge element from a Kuzu relationship object. */
function edgeEntry(raw, fallbackLabel) {
  return {
    data: {
      ...graphProps(raw),
      id: formatId(raw._id),
      source: formatId(raw._src),
      target: formatId(raw._dst),
      label: raw._label || fallbackLabel,
    },
  };
}

// ---------------------------------------------------------------------------
// Entity extraction from query results
// ---------------------------------------------------------------------------

// `{ table, offset }` — the shape of _id, _src and _dst.
function isInternalId(v) {
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.table !== "undefined" &&
    typeof v.offset !== "undefined"
  );
}

function isRelValue(v) {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    isInternalId(v._id) &&
    isInternalId(v._src) &&
    isInternalId(v._dst)
  );
}

function isNodeValue(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && isInternalId(v._id) && !isRelValue(v);
}

// Rows can nest arbitrarily deep (LIST of STRUCT of path of ...), so walk them
// recursively. A WeakSet keeps cyclic structures from recursing forever and the
// depth cap bounds pathological payloads.
const MAX_DEPTH = 64;

/**
 * Build a { nodes, edges } payload from the rows of any query result.
 *
 * Nodes and relationships are deduplicated by id; a relationship is only drawn
 * when both of its endpoints are in the payload (Cytoscape rejects dangling
 * edges) — those are counted in `skippedEdges` so the UI can explain the gap.
 * Node colors are assigned per label, in order of first appearance.
 *
 * @param {Array<any>} rows rows as returned by QueryResult.getAll()
 * @returns {{nodes: Array<object>, edges: Array<object>, skippedEdges: number}}
 */
function graphFromRows(rows) {
  const rawNodes = new Map(); // id -> Kuzu node object
  const rawRels = new Map(); // id -> Kuzu relationship object
  const typeOrder = [];
  const seen = new WeakSet();

  function visit(value, depth) {
    if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    // Order matters: a relationship also has an _id.
    if (isRelValue(value)) {
      const id = formatId(value._id);
      if (id !== null && !rawRels.has(id)) rawRels.set(id, value);
      return;
    }
    if (isNodeValue(value)) {
      const id = formatId(value._id);
      if (id !== null && !rawNodes.has(id)) {
        rawNodes.set(id, value);
        const type = value._label || UNKNOWN_NODE_TYPE;
        if (!typeOrder.includes(type)) typeOrder.push(type);
      }
      return;
    }
    // Anything else (a row object, a path's _nodes/_rels, a STRUCT, a MAP) is a
    // container: keep looking inside it.
    for (const key of Object.keys(value)) visit(value[key], depth + 1);
  }

  for (const row of rows || []) visit(row, 0);

  const typeColors = colorMapFor(typeOrder);
  const nodes = [];
  for (const raw of rawNodes.values()) {
    nodes.push(nodeEntry(raw, UNKNOWN_NODE_TYPE, typeColors));
  }

  const edges = [];
  let skippedEdges = 0;
  for (const raw of rawRels.values()) {
    const src = formatId(raw._src);
    const dst = formatId(raw._dst);
    if (src === null || dst === null || !rawNodes.has(src) || !rawNodes.has(dst)) {
      skippedEdges += 1;
      continue;
    }
    edges.push(edgeEntry(raw, UNKNOWN_REL_LABEL));
  }

  return { nodes, edges, skippedEdges };
}

module.exports = {
  TYPE_PALETTE,
  UNKNOWN_NODE_TYPE,
  UNKNOWN_REL_LABEL,
  formatId,
  stripInternal,
  graphProps,
  pickLabel,
  colorMapFor,
  nodeEntry,
  edgeEntry,
  isInternalId,
  isNodeValue,
  isRelValue,
  graphFromRows,
};
