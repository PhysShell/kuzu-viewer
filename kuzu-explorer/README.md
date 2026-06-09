# Kuzu Explorer

Browse [Kuzu](https://kuzudb.com/) graph databases directly inside VS Code: schema tree, table data, ad-hoc Cypher queries, and an interactive graph view. This is a native TypeScript port of the project's FastAPI `kuzu-viewer` web app.

## How it works

Kuzu ships a native Node addon that cannot be loaded reliably inside VS Code's Electron extension host. So the extension spawns a small worker (`worker/dbWorker.js`) under your **system Node.js** and talks to it over newline-delimited JSON-RPC on stdio. The worker owns the Kuzu `Database`/`Connection` and implements `connect`, `schema`, `table`, `query`, and `graph` — mirroring the FastAPI endpoints, including the read-only snapshot-copy fallback when the DB file is locked by another process.

## Requirements

- VS Code 1.85+
- Node.js available on your PATH (or set `kuzuExplorer.nodePath`). The bundled `kuzu` npm package provides the native binary used by the worker.

## Build & run (development)

```bash
cd kuzu-explorer
npm install        # installs kuzu + cytoscape + tooling
npm run compile    # tsc -> out/
```

Then open the `kuzu-explorer/` folder in VS Code and press **F5** ("Run Kuzu Explorer Extension"). A second VS Code window (Extension Development Host) opens with the extension loaded.

## Usage

1. Click the **Kuzu Explorer** icon in the activity bar.
2. Click **Connect to Database** and enter a path — e.g. the sibling `../test_db`.
3. Choose **Read-only** (recommended) or **Read-write**.
4. Browse the schema tree (Node Tables / Rel Tables -> properties). Click a table to load its rows.
5. Toolbar buttons: **Run Cypher Query**, **Show Graph**, **Refresh Schema**, **Disconnect**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kuzuExplorer.nodePath` | `node` | Node.js executable used to run the worker. |
| `kuzuExplorer.defaultReadOnly` | `true` | Default connection mode. |
| `kuzuExplorer.rowLimit` | `100` | Max rows when browsing a table. |
| `kuzuExplorer.graphLimit` | `500` | Max nodes/edges per table in the graph view. |

## Package as a .vsix

```bash
npx @vscode/vsce package
```

Note: the `kuzu` native binary is platform-specific, so a packaged `.vsix` only runs on the same OS/arch it was built on.
