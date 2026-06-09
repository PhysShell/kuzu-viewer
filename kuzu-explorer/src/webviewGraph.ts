import * as vscode from "vscode";
import { KuzuClient } from "./kuzuClient";

export function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** Build the Cytoscape graph webview HTML for a given webview. */
export function graphHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const cytoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "node_modules", "cytoscape", "dist", "cytoscape.min.js")
  );
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  #cy { position: absolute; top: 0; left: 0; right: 320px; bottom: 0; }
  #side {
    position: absolute; top: 0; right: 0; bottom: 0; width: 320px; box-sizing: border-box;
    border-left: 1px solid var(--vscode-panel-border); padding: 12px; overflow: auto;
    background: var(--vscode-editorWidget-background);
  }
  #toolbar { position: absolute; top: 10px; left: 10px; z-index: 5; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  h3 { margin: 4px 0 10px; font-size: 13px; }
  .k { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td { border-bottom: 1px solid var(--vscode-panel-border); padding: 3px 4px; vertical-align: top; word-break: break-word; }
  td.k { width: 40%; }
  #status { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style>
</head>
<body>
  <div id="toolbar"><button id="reload">Reload</button></div>
  <div id="cy"></div>
  <div id="side">
    <h3>Details</h3>
    <div id="status">Loading…</div>
    <div id="details" class="k">Select a node or edge.</div>
  </div>
  <script nonce="${nonce}" src="${cytoUri}"></script>
  <script nonce="${nonce}">
    var vscodeApi = acquireVsCodeApi();
    var statusEl = document.getElementById('status');
    var detailsEl = document.getElementById('details');
    var cy = null;
    document.getElementById('reload').addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'reload' });
    });

    function showDetails(data) {
      detailsEl.className = '';
      detailsEl.innerHTML = '';
      var table = document.createElement('table');
      Object.keys(data).forEach(function (k) {
        if (k === 'source' || k === 'target') return;
        var tr = document.createElement('tr');
        var k1 = document.createElement('td'); k1.className = 'k'; k1.textContent = k;
        var k2 = document.createElement('td');
        var v = data[k];
        k2.textContent = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
        tr.appendChild(k1); tr.appendChild(k2); table.appendChild(tr);
      });
      detailsEl.appendChild(table);
    }

    function draw(nodes, edges) {
      statusEl.textContent = nodes.length + ' nodes, ' + edges.length + ' edges';
      cy = cytoscape({
        container: document.getElementById('cy'),
        elements: { nodes: nodes, edges: edges },
        style: [
          { selector: 'node', style: {
            'background-color': 'data(color)', 'label': 'data(label)', 'color': '#fff',
            'font-size': 9, 'text-valign': 'center', 'text-halign': 'center',
            'text-outline-color': '#000', 'text-outline-width': 1.5,
            'width': 28, 'height': 28 } },
          { selector: 'edge', style: {
            'width': 1.5, 'line-color': '#999', 'target-arrow-color': '#999',
            'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
            'label': 'data(label)', 'font-size': 7, 'color': '#bbb' } },
          { selector: ':selected', style: { 'background-color': '#e0a458', 'line-color': '#e0a458', 'target-arrow-color': '#e0a458' } }
        ],
        layout: { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 }
      });
      cy.on('tap', 'node', function (evt) { showDetails(evt.target.data()); });
      cy.on('tap', 'edge', function (evt) { showDetails(evt.target.data()); });
      cy.on('tap', function (evt) { if (evt.target === cy) { detailsEl.className = 'k'; detailsEl.textContent = 'Select a node or edge.'; } });
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (msg.type === 'loading') { statusEl.textContent = 'Loading…'; }
      else if (msg.type === 'graph') {
        if (typeof cytoscape === 'undefined') { statusEl.textContent = 'cytoscape failed to load'; return; }
        draw(msg.nodes, msg.edges);
      }
      else if (msg.type === 'error') {
        statusEl.textContent = '';
        detailsEl.className = 'error'; detailsEl.textContent = msg.message;
      }
    });

    vscodeApi.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

/**
 * Wire a webview that uses graphHtml() to load graph data from the client.
 * Returns a Disposable for the message subscription.
 */
export function attachGraph(
  webview: vscode.Webview,
  client: KuzuClient,
  graphLimit: number
): vscode.Disposable {
  const load = async () => {
    void webview.postMessage({ type: "loading" });
    try {
      const g = await client.graph(graphLimit);
      void webview.postMessage({ type: "graph", nodes: g.nodes, edges: g.edges });
    } catch (e: any) {
      void webview.postMessage({ type: "error", message: e?.message ?? String(e) });
    }
  };
  return webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "ready" || msg?.type === "reload") {
      await load();
    }
  });
}
