# Kuzu Viewer

Two ways to browse a [Kuzu](https://kuzudb.com/) graph database:

- **[`kuzu-explorer/`](kuzu-explorer/)** — a VS Code extension (TypeScript). Schema tree, table data, ad-hoc Cypher queries, and an interactive graph view, right inside the editor.
- **[`python-app/`](python-app/)** — the original FastAPI web app (Python + static frontend) that the extension was ported from.

Both talk to a local Kuzu database file; neither requires a server beyond your machine.

## Repository layout

```
.
├─ kuzu-explorer/   VS Code extension (Node/TypeScript)
├─ python-app/      FastAPI web app (uv-managed)
├─ LICENSE          MIT
└─ test_db          local sample DB (gitignored; regenerate — see below)
```

## Quick start

### Generate a sample database

`test_db` is not committed. Create one with the included script:

```bash
cd python-app
uv run python mock_db.py   # writes ../test_db (User/City nodes, Follows/LivesIn rels)
```

### Run the web app

```bash
cd python-app
uv run uvicorn main:app --reload
# open http://127.0.0.1:8000 and connect to ../test_db
```

### Run the VS Code extension

```bash
cd kuzu-explorer
npm install
npm run compile
```

Open the `kuzu-explorer/` folder in VS Code and press **F5**. See [kuzu-explorer/README.md](kuzu-explorer/README.md) for full usage.

## Compatibility note

The Kuzu **storage format is version-specific**. The web app and the extension must use a `kuzu` version that matches whatever wrote your database file. This project currently pins **Kuzu 0.11.3** on both sides. If you regenerate or bring your own DB with a different Kuzu version, bump the `kuzu` dependency in `python-app/pyproject.toml` and `kuzu-explorer/package.json` to match.

## License

[MIT](LICENSE)

## Publishing the extension

The extension manifest's `publisher` is set to `gaintlabs` and `repository` points at this repo. To publish to the VS Code Marketplace you must own a publisher account with that ID (see the [vsce docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)). A packaged `.vsix` bundles a platform-specific native binary, so build it on (or for) the target OS/arch.
