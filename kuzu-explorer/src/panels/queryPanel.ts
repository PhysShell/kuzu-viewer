import * as vscode from "vscode";
import { GraphResult, KuzuClient } from "../kuzuClient";
import { GraphPanel } from "./graphPanel";

interface GraphInfo {
  nodes: number;
  edges: number;
  skipped: number;
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * A single reusable webview that hosts a Cypher editor and a results grid.
 * Also used to render the rows of a table selected in the tree.
 */
export class QueryPanel {
  private static current: QueryPanel | undefined;
  public static readonly viewType = "kuzuExplorer.query";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private rowLimit: number;
  private lastGraph: GraphResult | null = null;

  static show(client: KuzuClient, extensionUri: vscode.Uri): QueryPanel {
    const column = vscode.ViewColumn.Active;
    if (QueryPanel.current) {
      QueryPanel.current.panel.reveal(column);
      return QueryPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      QueryPanel.viewType,
      "Kuzu Query",
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    QueryPanel.current = new QueryPanel(panel, client, extensionUri);
    return QueryPanel.current;
  }

  /** Visualize the current panel's last query result, if it is drawable. */
  static visualizeLastResult(): boolean {
    return !!QueryPanel.current?.visualizeResult();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: KuzuClient,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.rowLimit = vscode.workspace.getConfiguration("kuzuExplorer").get<number>("rowLimit", 100);
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg?.type === "run") {
          await this.runQuery(String(msg.query ?? ""));
        } else if (msg?.type === "visualize") {
          this.visualizeResult();
        }
      },
      null,
      this.disposables
    );
  }

  async runQuery(query: string): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    this.lastGraph = null;
    this.post({ type: "setQuery", query: trimmed });
    this.post({ type: "loading" });
    try {
      const res = await this.client.query(trimmed);
      this.lastGraph = res.graph ?? null;
      this.post({
        type: "result",
        columns: res.columns,
        rows: res.rows,
        graph: infoOf(this.lastGraph),
      });
    } catch (e: any) {
      this.lastGraph = null;
      this.post({ type: "error", message: e?.message ?? String(e), graph: null });
    }
  }

  async showTable(name: string): Promise<void> {
    this.panel.reveal(vscode.ViewColumn.Active);
    this.lastGraph = null;
    this.post({ type: "loading" });
    try {
      const res = await this.client.table(name, this.rowLimit);
      const verb = res.kind === "NODE" ? `MATCH (n:\`${name}\`) RETURN n` : `MATCH ()-[r:\`${name}\`]->() RETURN r`;
      this.post({ type: "setQuery", query: `${verb} LIMIT ${this.rowLimit};` });
      this.post({
        type: "result",
        columns: res.columns,
        rows: res.rows,
        title: `${name} (${res.kind}) — up to ${this.rowLimit} rows`,
        graph: null,
      });
    } catch (e: any) {
      this.lastGraph = null;
      this.post({ type: "error", message: e?.message ?? String(e), graph: null });
    }
  }

  /** Open the shared graph panel on only the entities returned by this query. */
  visualizeResult(): boolean {
    if (!isDrawable(this.lastGraph)) {
      return false;
    }

    const graph = this.lastGraph!;
    GraphPanel.showResult(
      graph,
      this.client,
      this.extensionUri,
      `Kuzu Graph — result (${graph.nodes.length} nodes, ${graph.edges.length} edges)`
    );
    return true;
  }

  private post(message: any): void {
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    QueryPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    // The webview script intentionally avoids template literals so it can live
    // inside this TS template literal without ${} clashes.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
  .toolbar { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  textarea {
    width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 8px;
  }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.55; cursor: default; }
  button:disabled:hover { background: var(--vscode-button-secondaryBackground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .status { padding: 6px 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; padding: 10px; }
  .grid-wrap { overflow: auto; padding: 0 10px 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td {
    border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left;
    vertical-align: top; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
  tr:nth-child(even) td { background: var(--vscode-list-hoverBackground); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <div class="toolbar">
    <textarea id="q" placeholder="MATCH (n) RETURN n LIMIT 25;"></textarea>
    <div class="row">
      <button id="run">Run (Ctrl/Cmd+Enter)</button>
      <button id="viz" class="secondary" disabled>Visualize result</button>
      <span class="hint">Read-only connections reject write queries.</span>
    </div>
  </div>
  <div id="status" class="status"></div>
  <div id="out" class="grid-wrap"></div>
  <script nonce="${nonce}">
    var vscodeApi = acquireVsCodeApi();
    var qEl = document.getElementById('q');
    var outEl = document.getElementById('out');
    var statusEl = document.getElementById('status');
    var vizEl = document.getElementById('viz');

    function run() {
      vscodeApi.postMessage({ type: 'run', query: qEl.value });
    }
    document.getElementById('run').addEventListener('click', run);
    vizEl.addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'visualize' });
    });
    qEl.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    function setViz(info) {
      if (!info || (!info.nodes && !info.edges)) {
        vizEl.disabled = true;
        vizEl.textContent = 'Visualize result';
        vizEl.title = info && info.skipped
          ? 'Cannot draw: ' + info.skipped + ' relationship' +
            (info.skipped === 1 ? '' : 's') +
            ' were returned without both endpoint nodes.'
          : 'Disabled: return nodes, relationships with endpoints, or paths to draw a graph.';
        return;
      }

      vizEl.disabled = false;
      vizEl.textContent = 'Visualize result (' + info.nodes + ' node' +
        (info.nodes === 1 ? '' : 's') + ', ' + info.edges + ' edge' +
        (info.edges === 1 ? '' : 's') + ')';
      vizEl.title = 'Draw only the graph entities returned by this query.';
    }

    function fmt(v) {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    }

    function render(columns, rows, title) {
      outEl.innerHTML = '';
      statusEl.textContent = (title ? title + '  —  ' : '') + rows.length + ' row' + (rows.length === 1 ? '' : 's');
      if (!rows.length) { return; }
      var cols = columns && columns.length ? columns.slice() : [];
      if (!cols.length) {
        var seen = {};
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            for (var k in r) { if (!seen[k]) { seen[k] = true; cols.push(k); } }
          }
        }
      }
      var table = document.createElement('table');
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      var idxTh = document.createElement('th'); idxTh.textContent = '#'; htr.appendChild(idxTh);
      for (var c = 0; c < cols.length; c++) {
        var th = document.createElement('th'); th.textContent = cols[c]; htr.appendChild(th);
      }
      thead.appendChild(htr); table.appendChild(thead);
      var tbody = document.createElement('tbody');
      for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        var tr = document.createElement('tr');
        var idxTd = document.createElement('td'); idxTd.className = 'num'; idxTd.textContent = String(ri + 1); tr.appendChild(idxTd);
        for (var ci = 0; ci < cols.length; ci++) {
          var td = document.createElement('td');
          var val = (row && typeof row === 'object' && !Array.isArray(row)) ? row[cols[ci]] : (ci === 0 ? row : undefined);
          if (typeof val === 'number' || typeof val === 'bigint') td.className = 'num';
          var text = fmt(val);
          td.textContent = text;
          td.title = text;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      outEl.appendChild(table);
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (msg.type === 'setQuery') { qEl.value = msg.query; }
      else if (msg.type === 'loading') {
        statusEl.textContent = 'Running…';
        outEl.innerHTML = '';
        setViz(null);
      }
      else if (msg.type === 'result') {
        setViz(msg.graph);
        render(msg.columns, msg.rows, msg.title);
      }
      else if (msg.type === 'error') {
        setViz(null);
        statusEl.textContent = '';
        outEl.innerHTML = '';
        var d = document.createElement('div'); d.className = 'error'; d.textContent = msg.message;
        outEl.appendChild(d);
      }
    });
    setViz(null);
  </script>
</body>
</html>`;
  }
}


function isDrawable(graph: GraphResult | null): graph is GraphResult {
  return !!graph && (graph.nodes.length > 0 || graph.edges.length > 0);
}

function infoOf(graph: GraphResult | null): GraphInfo | null {
  if (!graph) {
    return null;
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    skipped: graph.skippedEdges ?? 0,
  };
}
