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

### 🕸️ Interactive graph view
Visualize your data as a graph powered by [Cytoscape](https://js.cytoscape.org/). Nodes are labeled by a real name property and colored by table type; click any node or edge to inspect its properties.

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
| **Kuzu: Show Graph** | Open the graph visualization |
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
| `kuzuExplorer.graphLimit` | `500` | Max nodes/edges per table in the graph view |

---

## 📋 Requirements

- **VS Code** 1.85+
- **Node.js** available on your `PATH` (or set `kuzuExplorer.nodePath`). Kuzu's native engine runs in this Node process, not inside VS Code.
- A database whose storage version matches the bundled **Kuzu 0.11.3**. Databases written by a different Kuzu version won't open unless the extension is rebuilt against a matching version.

---

## ⚠️ Known limitations

- A published build includes Kuzu's native binary for **one platform/architecture** only.
- The graph view samples up to `graphLimit` nodes/edges **per table**; very large graphs are not rendered in full.

---

## 📝 Release notes

### 0.1.0
Initial release: schema tree, table browsing, Cypher query panel, interactive graph view, open-as-database, and read-only snapshot fallback.

---

Made with ❤️ for [Kuzu](https://kuzudb.com/). Source, issues, and contributions: <https://github.com/gaintlabs/kuzu-viewer>. Licensed under [MIT](LICENSE).
