# Kuzu Viewer — web app

FastAPI app that serves a browser UI for inspecting a local [Kuzu](https://kuzudb.com/) graph database: schema, table data, Cypher queries, and a Cytoscape graph view.

Managed with [uv](https://docs.astral.sh/uv/).

## Setup

```bash
uv sync                      # create .venv from pyproject.toml / uv.lock
```

## Generate the sample database

```bash
uv run python mock_db.py     # writes ../test_db
```

## Run

```bash
uv run uvicorn main:app --reload
# http://127.0.0.1:8000
```

In the UI, connect to `../test_db` (the default). Read-only mode is recommended and does not lock the database for other readers/writers; if the file is locked, the app falls back to a temporary snapshot copy.

## Notes

- Requires Python 3.12 (see `.python-version`).
- The bundled `kuzu` version must match the storage version of the database file you open. This app pins Kuzu 0.11.3.
