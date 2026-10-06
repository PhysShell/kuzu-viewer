# Kuzu Explorer

> Explore your [Kuzu](https://kuzudb.com/) graph database right inside VS Code — schema, tables, Cypher, and an interactive graph view.

Kuzu Explorer turns VS Code into a viewer for local Kuzu graph databases. Point it at a database file and get an instant tree of your tables, a spreadsheet-style view of your rows, a Cypher scratchpad, and a clickable graph — without spinning up a separate tool.

---

## ✨ Features

### 🗂️ Schema at a glance
A dedicated activity-bar view lists your **Node Tables** and **Rel Tables**. Expand any table to see its properties, types, and primary keys.

### 📋 Browse table data
Click a table to load its rows into a clean, sortable results grid — no query writing required.

### ⚡ Run Cypher
A built-in query panel lets you write and execute Cypher (**Ctrl/Cmd + Enter**) and see results as a table. Write queries are blocked automatically in read-only mode.

### 🎯 Visualize a query result
Every query result is inspected for the nodes, relationships and paths it returned, so the results grid gets a **Visualize result (N nodes, M edges)** button. It draws *only that subgraph* in the graph view — no rescan of the database, no unrelated tables:

```cypher
MATCH (s:Symbol)-[hd:HAS_DECLARATION]->(d:SourceDeclaration)
      -[di:DECLARED_IN]->(f:SourceFile)
WHERE s.kind = 'method' AND s.name = 'Save'
RETURN s, hd, d, di, f LIMIT 30
```

The button is disabled (with the reason) when a query returns no graph entities, e.g. `RETURN s.name, count(*)`. Relationships whose endpoints are not in the result cannot be drawn and are counted in the button's tooltip instead.

### 🕸️ Interactive graph view
Visualize your data as a graph powered by [Cytoscape](https://js.cytoscape.org/). Nodes are labeled by a real name property and colored by table type; click any node or edge to inspect its properties. Use **Group by** to circle each node together with the nodes it owns through a relationship (e.g. a table and its columns via `HAS_COLUMN`), labeled by `db_id`. The details pane can be resized by dragging its edge, or hidden.

### 📂 Open a database in one click
Right-click a database file or folder in the Explorer and choose **Open as Kuzu Database**, or double-click a `.kuzu` / `.kz` / `.kuzudb` file.

### 🔒 Safe by default
Connects **read-only** so it never holds a write lock. If the database is already locked by another process, it transparently opens a temporary snapshot instead.

---

## 🚀 Quick start

1. Install the extension and reload VS Code.
2. Click the **Kuzu Explorer** icon in the activity bar.
3. Choose **Connect to Database** and enter the path to your Kuzu database.
4. Pick **Read-only** (recommended) or **Read-write**.
5. Browse the schema, click a table, or use the toolbar to **Run Cypher Query** or **Show Graph**.

> 💡 Tip: you can also just right-click a database file in the Explorer and pick **Open as Kuzu Database**.

---

## 🧭 Commands

| Command | What it does |
| --- | --- |
| **Kuzu: Connect to Database** | Connect to a database by path |
| **Kuzu: Run Cypher Query** | Open the query panel |
| **Kuzu: Show Graph** | Open the graph visualization of the whole database |
| **Kuzu: Visualize Last Query Result** | Draw the last query result's subgraph in the graph view |
| **Kuzu: Refresh Schema** | Reload the schema tree |
| **Kuzu: Disconnect** | Close the current connection |
| **Open as Kuzu Database** | Explorer right-click action |

---

## ⚙️ Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kuzuExplorer.nodePath` | `node` | Node.js executable used to run the database worker |
| `kuzuExplorer.defaultReadOnly` | `true` | Connect read-only by default |
| `kuzuExplorer.rowLimit` | `100` | Max rows when browsing a table |
| `kuzuExplorer.graphLimit` | `2000` | Max nodes/edges per table in the graph view |

---

## 📋 Requirements

- **VS Code** 1.85+
- **Node.js** available on your `PATH` (or set `kuzuExplorer.nodePath`). Kuzu's native engine runs in this Node process, not inside VS Code.
- A database whose storage version matches the bundled **Kuzu 0.11.3**. Databases written by a different Kuzu version won't open unless the extension is rebuilt against a matching version.

---

## ⚠️ Known limitations

- A published build includes Kuzu's native binary for **one platform/architecture** only.
- The graph view samples up to `graphLimit` nodes/edges **per table**; very large graphs are not rendered in full. For a focused view, run a query and use **Visualize result** instead.
- **Visualize result** draws only what a query returned: a relationship is shown only when both of its endpoints are in the result, so `MATCH ()-[r]->() RETURN r` draws nothing on its own.

---

## 🧪 Development

```bash
cd kuzu-explorer
npm install     # also fetches Kuzu's prebuilt native binary
npm run compile # tsc -> out/
npm test        # compiles, then runs the unit + worker/webview integration tests
```

`npm test` runs the real database worker against a temporary Kuzu database, and drives the webview scripts in a minimal DOM, so the query → extract → render path is covered end to end. Tests skip the Kuzu parts automatically if the native addon is not installed.

---

## 📝 Release notes

### 0.2.2
- **Visualize Cypher query results in the graph view.** The Cypher panel now extracts the nodes, relationships and paths a query returned and offers a **Visualize result (N nodes, M edges)** action that renders just that subgraph in the existing Cytoscape view — without rescanning the database. Works with `RETURN a, r, b`, `RETURN p` (paths), and nested `collect(...)` results; disabled with an explanation when a query returns only scalar values.

- Windows `.vsix` builds are attached to CI runs; version tags also publish the artifact to a GitHub Release.

### 0.2.1
- Smaller package: unused dependencies are no longer shipped (571 → 40 files), so the extension installs and loads faster.

### 0.2.0
- LadybugDB support: both engines are bundled and selected per database file.
- Graph view: fixed the graph rendering blank or squashed in narrow editors; the details pane is now resizable and can be hidden; new **Fit** button.
- Graph view: **Group by** a relationship (e.g. `HAS_COLUMN`) to circle each table with its columns, labeled by `db_id`, in a compact non-overlapping layout.
- `kuzuExplorer.graphLimit` default raised to 2000, with a warning when tables are truncated.
- Intel macOS (darwin-x64) builds are no longer published.

### 0.1.0
Initial release: schema tree, table browsing, Cypher query panel, interactive graph view, open-as-database, and read-only snapshot fallback.

---

Made with ❤️ for [Kuzu](https://kuzudb.com/). Source, issues, and contributions: <https://github.com/gaintlabs/kuzu-viewer>. Licensed under [MIT](LICENSE).
