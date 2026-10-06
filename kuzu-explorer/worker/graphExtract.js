"use strict";
/*
 * graphExtract.js — turn Kuzu/Ladybug graph entities returned by a query into
 * Cytoscape elements. Shared by the whole-database graph and query-result graph.
 */

const TYPE_PALETTE = [
  "#4f8cc9", "#e0a458", "#6cbf84", "#c96f9b",
  "#9b7fd1", "#d1786f", "#5bb3c9", "#b3a14f",
];

const UNKNOWN_NODE_TYPE = "node";
const UNKNOWN_REL_LABEL = "rel";
const LABEL_KEYS = ["name", "title", "label", "displayName", "key", "id", "db_id"];
const CY_RESERVED = ["parent", "source", "target"];
const MAX_DEPTH = 64;

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

function pickLabel(props, fallback) {
  for (const k of LABEL_KEYS) {
    const v = props[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v);
    }
  }
  for (const v of Object.values(props)) {
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
  }
  return fallback;
}

function colorMapFor(types) {
  const colors = {};
  types.forEach((t, i) => {
    colors[t] = TYPE_PALETTE[i % TYPE_PALETTE.length];
  });
  return colors;
}

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
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    isInternalId(v._id) &&
    !isRelValue(v)
  );
}

/**
 * Extract graph entities from arbitrary query rows. Rows may contain nodes,
 * relationships, paths, LISTs, STRUCTs, or nested combinations of those.
 *
 * Relationships are rendered only when both endpoints were also returned by
 * the query. Missing-endpoint relationships are counted in skippedEdges so the
 * UI can explain why a graph cannot be drawn from e.g. RETURN r alone.
 */
function graphFromRows(rows) {
  const rawNodes = new Map();
  const rawRels = new Map();
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

    // Order matters because relationships also carry an _id.
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

    for (const key of Object.keys(value)) {
      visit(value[key], depth + 1);
    }
  }

  for (const row of rows || []) {
    visit(row, 0);
  }

  const typeColors = colorMapFor(typeOrder);
  const nodes = Array.from(rawNodes.values(), (raw) =>
    nodeEntry(raw, UNKNOWN_NODE_TYPE, typeColors)
  );

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
