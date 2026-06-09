import kuzu
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
import os
import gc
import shutil
import tempfile

app = FastAPI(title="Kuzu Viewer")

# Global state
db_manager = {
    "db": None,
    "conn": None,
    "path": None,
    "read_only": False,
    "temp_dir": None,
}

WRITE_KEYWORDS = {"CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "ALTER", "COPY", "INSTALL", "LOAD"}

class ConnectRequest(BaseModel):
    path: str
    read_only: bool = True

class QueryRequest(BaseModel):
    query: str


def _release_db():
    """Close any open connection/database so Kuzu releases its file lock."""
    conn = db_manager.get("conn")
    db = db_manager.get("db")
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    if db is not None:
        try:
            db.close()
        except Exception:
            pass
    db_manager["conn"] = None
    db_manager["db"] = None
    db_manager["path"] = None
    db_manager["read_only"] = False
    tmp_dir = db_manager.get("temp_dir")
    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        db_manager["temp_dir"] = None
    gc.collect()


def _copy_db_for_readonly(src_path: str):
    """Mirror the Kuzu DB to a temp directory so we can open it without
    fighting another process for the file lock. Returns (tmp_root, db_path_to_open)."""
    src_path = os.path.abspath(src_path)
    tmp_root = tempfile.mkdtemp(prefix="kuzu-viewer-ro-")
    try:
        if os.path.isdir(src_path):
            dst_dir = os.path.join(
                tmp_root, os.path.basename(src_path.rstrip(os.sep)) or "db"
            )
            shutil.copytree(src_path, dst_dir, symlinks=False)
            return tmp_root, dst_dir

        # File-based DB (path is either "<stem>" or "<stem>.kuzu").
        parent = os.path.dirname(src_path) or "."
        base = os.path.basename(src_path)
        stem = base[:-len(".kuzu")] if base.endswith(".kuzu") else base
        copied = 0
        for fname in os.listdir(parent):
            # Match the DB file plus its WAL / shadow siblings.
            if fname == base or fname.startswith(stem + "."):
                shutil.copy2(
                    os.path.join(parent, fname),
                    os.path.join(tmp_root, fname),
                )
                copied += 1
        if copied == 0:
            raise RuntimeError(f"No Kuzu DB files found near {src_path}")
        return tmp_root, os.path.join(tmp_root, base)
    except Exception:
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise


def _is_lock_error(err: Exception) -> bool:
    msg = str(err).lower()
    return "could not set lock" in msg or "lock on file" in msg


def _is_write_query(query: str) -> bool:
    stripped = query.lstrip()
    # Strip line comments
    cleaned_tokens = []
    for line in stripped.splitlines():
        line = line.split("//")[0]
        cleaned_tokens.extend(line.upper().split())
    return any(tok in WRITE_KEYWORDS for tok in cleaned_tokens)

def format_id(id_dict):
    if id_dict is None:
        return None
    return f"{id_dict.get('table')}_{id_dict.get('offset')}"

@app.post("/api/connect")
async def connect_db(req: ConnectRequest):
    if not os.path.exists(req.path):
        raise HTTPException(status_code=400, detail="Database path does not exist.")
    # Release any prior connection first so we don't hold two locks.
    _release_db()
    try:
        db = kuzu.Database(req.path, read_only=req.read_only)
        conn = kuzu.Connection(db)
        db_manager["db"] = db
        db_manager["conn"] = conn
        db_manager["path"] = req.path
        db_manager["read_only"] = req.read_only
        mode = "read-only" if req.read_only else "read-write"
        return {"status": "success", "message": f"Connected to {req.path} ({mode})", "read_only": req.read_only, "temp_copy": False}
    except Exception as e:
        # If another process holds the lock and we only need read access,
        # fall back to opening a snapshot copy.
        if req.read_only and _is_lock_error(e):
            try:
                tmp_root, copy_path = _copy_db_for_readonly(req.path)
            except Exception as copy_err:
                _release_db()
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"DB is locked by another process and the snapshot fallback "
                        f"could not copy the files: {copy_err}"
                    ),
                )
            try:
                db = kuzu.Database(copy_path, read_only=True)
                conn = kuzu.Connection(db)
                db_manager["db"] = db
                db_manager["conn"] = conn
                db_manager["path"] = req.path
                db_manager["read_only"] = True
                db_manager["temp_dir"] = tmp_root
                return {
                    "status": "success",
                    "message": (
                        f"Connected to a temp snapshot of {req.path} "
                        f"(original was locked by another process). Read-only."
                    ),
                    "read_only": True,
                    "temp_copy": True,
                }
            except Exception as inner:
                shutil.rmtree(tmp_root, ignore_errors=True)
                _release_db()
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to open temp snapshot of locked DB: {inner}",
                )
        _release_db()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/disconnect")
async def disconnect_db():
    if db_manager.get("db") is None:
        return {"status": "success", "message": "Already disconnected."}
    path = db_manager.get("path")
    _release_db()
    return {"status": "success", "message": f"Released {path}"}


@app.get("/api/status")
async def get_status():
    return {
        "connected": db_manager.get("db") is not None,
        "path": db_manager.get("path"),
        "read_only": db_manager.get("read_only", False),
    }

@app.get("/api/schema")
async def get_schema():
    conn = db_manager.get("conn")
    if not conn:
        raise HTTPException(status_code=400, detail="Database not connected.")
    try:
        tables_res = conn.execute("CALL SHOW_TABLES() RETURN *")
        schema = []
        while tables_res.has_next():
            row = tables_res.get_next()
            table_name = row[1]
            table_type = row[2]
            # Get properties
            info_res = conn.execute(f"CALL TABLE_INFO('{table_name}') RETURN *")
            properties = []
            while info_res.has_next():
                prop_row = info_res.get_next()
                properties.append({"property id": prop_row[0], "name": prop_row[1], "type": prop_row[2], "primary key": prop_row[4]})
            schema.append({
                "name": table_name,
                "type": table_type,
                "properties": properties
            })
        return {"schema": schema}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/graph")
async def get_graph():
    conn = db_manager.get("conn")
    if not conn:
        raise HTTPException(status_code=400, detail="Database not connected.")
    try:
        # To get the whole graph generically, we can query all nodes, then all relationships.
        # This could be heavy for huge graphs, so we limit to 1000 nodes and rels.
        nodes = []
        edges = []

        # Get tables to query
        tables_res = conn.execute("CALL SHOW_TABLES() RETURN *")
        node_tables = []
        rel_tables = []
        while tables_res.has_next():
            row = tables_res.get_next()
            if row[2] == "NODE":
                node_tables.append(row[1])
            elif row[2] == "REL":
                rel_tables.append(row[1])

        node_id_set = set()

        for nt in node_tables:
            res = conn.execute(f"MATCH (n:{nt}) RETURN n LIMIT 500")
            while res.has_next():
                n = res.get_next()[0]
                n_id_str = format_id(n['_id'])
                if n_id_str not in node_id_set:
                    node_id_set.add(n_id_str)
                    # Filter out internal None fields
                    props = {k: v for k, v in n.items() if not k.startswith('_') and v is not None}
                    if 'id' in props:
                        props['db_id'] = props.pop('id')
                    nodes.append({
                        "data": {
                            "id": n_id_str,
                            "label": n.get('_label', nt),
                            **props
                        }
                    })

        for rt in rel_tables:
            res = conn.execute(f"MATCH (a)-[r:{rt}]->(b) RETURN r LIMIT 500")
            while res.has_next():
                r = res.get_next()[0]
                src_str = format_id(r['_src'])
                dst_str = format_id(r['_dst'])
                id_str = format_id(r['_id'])
                # Cytoscape crashes if an edge references a non-existent node.
                # So we ONLY add edges where both source and target are in node_id_set.
                if src_str in node_id_set and dst_str in node_id_set:
                    props = {k: v for k, v in r.items() if not k.startswith('_') and v is not None}
                    if 'id' in props:
                        props['db_id'] = props.pop('id')
                    edges.append({
                        "data": {
                            "id": id_str,
                            "source": src_str,
                            "target": dst_str,
                            "label": r.get('_label', rt),
                            **props
                        }
                    })

        return {"nodes": nodes, "edges": edges}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tables/{table_name}")
async def get_table_data(table_name: str):
    conn = db_manager.get("conn")
    if not conn:
        raise HTTPException(status_code=400, detail="Database not connected.")
    try:
        # Check if node or rel
        is_node = True
        tables_res = conn.execute("CALL SHOW_TABLES() RETURN *")
        while tables_res.has_next():
            row = tables_res.get_next()
            if row[1] == table_name and row[2] == "REL":
                is_node = False
                break
                
        if is_node:
            res = conn.execute(f"MATCH (n:{table_name}) RETURN n LIMIT 100")
        else:
            res = conn.execute(f"MATCH ()-[n:{table_name}]->() RETURN n LIMIT 100")
            
        data = []
        while res.has_next():
            data.append(res.get_next()[0])
        return {"data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/query")
async def execute_query(req: QueryRequest):
    conn = db_manager.get("conn")
    if not conn:
        raise HTTPException(status_code=400, detail="Database not connected.")
    if db_manager.get("read_only") and _is_write_query(req.query):
        raise HTTPException(status_code=403, detail="Database is connected in read-only mode. Reconnect with read-only disabled to run write queries.")
    try:
        res = conn.execute(req.query)
        data = []
        if res.has_next():
            while res.has_next():
                data.append(res.get_next())
        return {"status": "success", "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Mount static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")

