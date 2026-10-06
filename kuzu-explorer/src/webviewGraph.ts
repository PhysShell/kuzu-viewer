import * as vscode from "vscode";
import { GraphResult, KuzuClient } from "./kuzuClient";

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
  html, body { height: 100%; margin: 0; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  body { display: flex; }
  #main { position: relative; flex: 1 1 auto; min-width: 0; }
  #cy { position: absolute; inset: 0; }
  #overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; }
  #splitter { flex: 0 0 5px; cursor: col-resize; background: var(--vscode-panel-border); opacity: 0.6; }
  #splitter:hover, #splitter.dragging { background: var(--vscode-focusBorder); opacity: 1; }
  #side {
    flex: 0 0 auto; width: 320px; box-sizing: border-box; padding: 12px; overflow: auto;
    background: var(--vscode-editorWidget-background);
  }
  body.side-hidden #side, body.side-hidden #splitter { display: none; }
  body.dragging { cursor: col-resize; user-select: none; }
  #toolbar { position: absolute; top: 10px; left: 10px; right: 10px; z-index: 5; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; pointer-events: none; }
  #toolbar > * { pointer-events: auto; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  label.group { font-size: 12px; display: flex; align-items: center; gap: 4px; background: var(--vscode-editorWidget-background); padding: 2px 6px; border-radius: 4px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); font-size: 12px; padding: 2px; }
  h3 { margin: 4px 0 10px; font-size: 13px; }
  .k { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td { border-bottom: 1px solid var(--vscode-panel-border); padding: 3px 4px; vertical-align: top; word-break: break-word; }
  td.k { width: 40%; }
  #status { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style>
</head>
<body>
  <div id="main">
    <div id="toolbar">
      <button id="reload">Reload</button>
      <button id="fit" class="secondary">Fit</button>
      <label class="group" title="Draw a circle around each node and the nodes it points to via this relationship">Group by
        <select id="groupBy"><option value="">None</option></select>
      </label>
      <button id="toggleSide" class="secondary">Hide details</button>
    </div>
    <div id="cy"></div>
    <canvas id="overlay"></canvas>
  </div>
  <div id="splitter" title="Drag to resize"></div>
  <div id="side">
    <h3>Details</h3>
    <div id="status">Loading…</div>
    <div id="details" class="k">Select a node or edge.</div>
  </div>
  <script nonce="${nonce}" src="${cytoUri}"></script>
  <script nonce="${nonce}">
    var vscodeApi = acquireVsCodeApi();
    var state = vscodeApi.getState() || {};
    var statusEl = document.getElementById('status');
    var detailsEl = document.getElementById('details');
    var cyEl = document.getElementById('cy');
    var sideEl = document.getElementById('side');
    var splitterEl = document.getElementById('splitter');
    var groupSel = document.getElementById('groupBy');
    var toggleBtn = document.getElementById('toggleSide');
    var cy = null;
    var raw = null;           // last graph payload from the extension
    var layoutPending = false; // layout deferred until the container has a real size

    function saveState(patch) {
      Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
      vscodeApi.setState(state);
    }

    // ---- Details pane: resizable + collapsible -------------------------------
    var MIN_SIDE = 160, MIN_GRAPH = 160;
    function clampSide(w) {
      return Math.max(MIN_SIDE, Math.min(w, window.innerWidth - MIN_GRAPH - 5));
    }
    function applySide() {
      var hidden = state.sideHidden !== undefined ? state.sideHidden : window.innerWidth < 520;
      document.body.classList.toggle('side-hidden', hidden);
      toggleBtn.textContent = hidden ? 'Show details' : 'Hide details';
      var w = state.sideWidth || Math.min(320, Math.round(window.innerWidth * 0.35));
      sideEl.style.width = clampSide(w) + 'px';
    }
    applySide();
    window.addEventListener('resize', applySide);
    toggleBtn.addEventListener('click', function () {
      saveState({ sideHidden: !document.body.classList.contains('side-hidden') });
      applySide();
    });
    splitterEl.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      splitterEl.setPointerCapture(e.pointerId);
      splitterEl.classList.add('dragging');
      document.body.classList.add('dragging');
    });
    splitterEl.addEventListener('pointermove', function (e) {
      if (!splitterEl.classList.contains('dragging')) return;
      sideEl.style.width = clampSide(window.innerWidth - e.clientX) + 'px';
    });
    function endDrag() {
      if (!splitterEl.classList.contains('dragging')) return;
      splitterEl.classList.remove('dragging');
      document.body.classList.remove('dragging');
      saveState({ sideWidth: sideEl.getBoundingClientRect().width });
    }
    splitterEl.addEventListener('pointerup', endDrag);
    splitterEl.addEventListener('pointercancel', endDrag);

    // ---- Keep the graph sized to its container -------------------------------
    function hasSize() { return cyEl.clientWidth > 40 && cyEl.clientHeight > 40; }
    new ResizeObserver(function () {
      sizeOverlay();
      if (!cy) return;
      cy.resize();
      if (layoutPending && hasSize()) runLayout();
    }).observe(cyEl);

    // ---- Cluster circles ------------------------------------------------------
    // Cytoscape draws compound parents as boxes, so the parents are invisible
    // (they only keep members together during layout) and a circle enclosing
    // each group's members is painted on an overlay canvas instead.
    var overlay = document.getElementById('overlay');
    var octx = overlay.getContext('2d');
    function sizeOverlay() {
      var dpr = window.devicePixelRatio || 1;
      overlay.width = Math.round(cyEl.clientWidth * dpr);
      overlay.height = Math.round(cyEl.clientHeight * dpr);
      paintClusters();
    }
    function paintClusters() {
      var dpr = window.devicePixelRatio || 1;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (!cy) return;
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var zoom = cy.zoom(), pan = cy.pan();
      var fg = getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim() || '#ccc';
      var labels = [];
      cy.nodes('[?isCluster]').forEach(function (p) {
        var kids = p.children();
        var bb = kids.boundingBox({ includeLabels: false });
        var mx = (bb.x1 + bb.x2) / 2, my = (bb.y1 + bb.y2) / 2, far = 0;
        kids.forEach(function (k) {
          var q = k.position();
          far = Math.max(far, Math.sqrt((q.x - mx) * (q.x - mx) + (q.y - my) * (q.y - my)));
        });
        var cx = mx * zoom + pan.x;
        var cyy = my * zoom + pan.y;
        var r = (far + CLUSTER_MARGIN) * zoom;
        var color = p.data('color');
        var sel = p.selected();
        octx.beginPath();
        octx.arc(cx, cyy, r, 0, Math.PI * 2);
        octx.globalAlpha = sel ? 0.18 : 0.07;
        octx.fillStyle = sel ? '#e0a458' : color;
        octx.fill();
        octx.globalAlpha = 0.85;
        octx.lineWidth = sel ? 2.5 : 1.5;
        octx.strokeStyle = sel ? '#e0a458' : color;
        octx.stroke();
        if (r > 14) labels.push({ text: p.data('label'), x: cx, y: cyy - r - 3, r: r, sel: sel });
      });
      // Labels go above their circle; bigger (and selected) groups win when
      // labels would collide, the rest appear as you zoom in.
      octx.globalAlpha = 1;
      octx.fillStyle = fg;
      var size = Math.max(10, Math.min(16, 13 * zoom * 4));
      octx.font = 'bold ' + size + 'px ' + getComputedStyle(document.body).fontFamily;
      octx.textAlign = 'center';
      octx.textBaseline = 'bottom';
      labels.sort(function (a, b) { return (b.sel - a.sel) || (b.r - a.r); });
      var drawn = [];
      labels.forEach(function (l) {
        var w = octx.measureText(l.text).width;
        var box = { x1: l.x - w / 2 - 2, x2: l.x + w / 2 + 2, y1: l.y - size - 2, y2: l.y + 2 };
        var hit = drawn.some(function (d) { return box.x1 < d.x2 && box.x2 > d.x1 && box.y1 < d.y2 && box.y2 > d.y1; });
        if (hit) return;
        drawn.push(box);
        octx.fillText(l.text, l.x, l.y);
      });
    }

    // Grouped layout: members of each group are packed in a sunflower around
    // the group owner, then the groups (as single discs) are laid out with a
    // force layout and pushed apart until no two circles overlap.
    var MEMBER_SPACING = 34, CLUSTER_MARGIN = 24, CLUSTER_GAP = 36;
    var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    function groupedLayout(parents) {
      var items = [], itemOf = {};
      parents.forEach(function (p) {
        var ownerId = p.id().slice('cluster:'.length);
        var kids = p.children();
        var owner = kids.filter(function (k) { return k.id() === ownerId; });
        var others = kids.difference(owner);
        var offsets = others.map(function (k, i) {
          var rad = MEMBER_SPACING * Math.sqrt(i + 1);
          return { x: rad * Math.cos(i * GOLDEN_ANGLE), y: rad * Math.sin(i * GOLDEN_ANGLE) };
        });
        var far = offsets.length ? MEMBER_SPACING * Math.sqrt(offsets.length) : 0;
        var item = { owner: owner, others: others, offsets: offsets, r: far + CLUSTER_MARGIN };
        kids.forEach(function (k) { itemOf[k.id()] = items.length; });
        items.push(item);
      });
      cy.nodes().orphans().filter(function (n) { return !n.data('isCluster'); }).forEach(function (n) {
        itemOf[n.id()] = items.length;
        items.push({ owner: n, others: cy.collection(), offsets: [], r: 16 });
      });

      // Force layout on one disc per item, sized so the layout knows about overlap.
      var metaEls = items.map(function (it, i) { return { data: { id: 'm' + i, d: it.r * 2 } }; });
      var seen = {};
      cy.edges().forEach(function (e) {
        var a = itemOf[e.source().id()], b = itemOf[e.target().id()];
        if (a === undefined || b === undefined || a === b) return;
        var key = a < b ? a + '-' + b : b + '-' + a;
        if (seen[key]) return;
        seen[key] = true;
        metaEls.push({ data: { id: 'me' + key, source: 'm' + a, target: 'm' + b } });
      });
      var meta = cytoscape({
        headless: true, styleEnabled: true, elements: metaEls,
        style: [{ selector: 'node', style: { width: 'data(d)', height: 'data(d)' } }]
      });
      meta.layout({
        name: 'cose', animate: false, randomize: true, fit: false,
        nodeOverlap: 40, componentSpacing: 120, gravity: 0.6,
        nodeRepulsion: function (n) { var d = n.data('d'); return 4000 + d * d * 6; },
        idealEdgeLength: function (e) { return (e.source().data('d') + e.target().data('d')) / 2 + 40; }
      }).run();
      var pos = items.map(function (it, i) { var q = meta.getElementById('m' + i).position(); return { x: q.x, y: q.y }; });
      meta.destroy();

      // Relax: push overlapping discs apart.
      for (var iter = 0; iter < 300; iter++) {
        var moved = false;
        for (var i = 0; i < items.length; i++) {
          for (var j = i + 1; j < items.length; j++) {
            var dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var need = items[i].r + items[j].r + CLUSTER_GAP;
            if (dist >= need) continue;
            if (dist < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = Math.sqrt(dx * dx + dy * dy); }
            var push = (need - dist) / 2 + 0.5;
            pos[i].x -= dx / dist * push; pos[i].y -= dy / dist * push;
            pos[j].x += dx / dist * push; pos[j].y += dy / dist * push;
            moved = true;
          }
        }
        if (!moved) break;
      }

      cy.batch(function () {
        items.forEach(function (it, i) {
          it.owner.position({ x: pos[i].x, y: pos[i].y });
          it.others.forEach(function (k, idx) {
            k.position({ x: pos[i].x + it.offsets[idx].x, y: pos[i].y + it.offsets[idx].y });
          });
        });
      });
      cy.fit(undefined, 40);
    }

    function runLayout() {
      if (!cy) return;
      if (!hasSize()) { layoutPending = true; return; }
      layoutPending = false;
      var parents = cy.nodes('[?isCluster]');
      if (parents.nonempty()) { groupedLayout(parents); return; }
      cy.layout({
        name: 'cose', animate: false, fit: true, padding: 30,
        nodeRepulsion: 8000, idealEdgeLength: 80, nestingFactor: 1.2, componentSpacing: 60
      }).run();
    }

    document.getElementById('reload').addEventListener('click', function () {
      vscodeApi.postMessage({ type: 'reload' });
    });
    document.getElementById('fit').addEventListener('click', function () {
      if (cy) { cy.resize(); cy.fit(undefined, 30); }
    });
    groupSel.addEventListener('change', function () {
      saveState({ groupBy: groupSel.value });
      if (raw) draw();
    });

    function showDetails(data) {
      detailsEl.className = '';
      detailsEl.innerHTML = '';
      var table = document.createElement('table');
      Object.keys(data).forEach(function (k) {
        if (k === 'source' || k === 'target' || k === 'parent' || k === 'color' || k === 'isCluster') return;
        var tr = document.createElement('tr');
        var k1 = document.createElement('td'); k1.className = 'k'; k1.textContent = k;
        var k2 = document.createElement('td');
        var v = data[k];
        k2.textContent = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
        tr.appendChild(k1); tr.appendChild(k2); table.appendChild(tr);
      });
      detailsEl.appendChild(table);
    }

    // ---- Grouping (compound "cluster" circles) -------------------------------
    // For relationship type R, each source node of R and all nodes it points to
    // via R are wrapped in a cluster circle labelled with the source's db_id
    // (e.g. a DbTable and its DbColumns via HAS_COLUMN).
    function relStats() {
      var stats = {};
      raw.edges.forEach(function (e) {
        var r = e.data.label;
        var s = stats[r] || (stats[r] = { count: 0, targets: {}, multiParent: false });
        s.count++;
        if (s.targets[e.data.target] && s.targets[e.data.target] !== e.data.source) s.multiParent = true;
        s.targets[e.data.target] = e.data.source;
      });
      return stats;
    }

    function populateGroupBy() {
      var stats = relStats();
      var rels = Object.keys(stats).sort();
      var wanted = state.groupBy;
      if (wanted === undefined) {
        // Auto-pick a containment-style relationship (HAS_*, CONTAINS...) where
        // every target has a single owner.
        wanted = rels.filter(function (r) {
          return /^(has|contains|owns)/i.test(r) && !stats[r].multiParent;
        })[0] || '';
      }
      groupSel.innerHTML = '<option value="">None</option>';
      rels.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r; o.textContent = r + ' (' + stats[r].count + ')';
        groupSel.appendChild(o);
      });
      groupSel.value = rels.indexOf(wanted) >= 0 ? wanted : '';
    }

    function buildElements(groupBy) {
      var byId = {};
      raw.nodes.forEach(function (n) { byId[n.data.id] = n.data; });
      var parentOf = {}, clusters = {};
      if (groupBy) {
        raw.edges.forEach(function (e) {
          var s = e.data.source, t = e.data.target;
          if (e.data.label !== groupBy || s === t || parentOf[t] !== undefined) return;
          parentOf[t] = s;
          clusters[s] = (clusters[s] || 0) + 1;
        });
        // Keep clusters flat: a cluster owner is never itself a member elsewhere.
        Object.keys(clusters).forEach(function (s) { delete parentOf[s]; });
      }
      var nodes = [];
      Object.keys(clusters).forEach(function (s) {
        var d = byId[s] || {};
        var name = d.db_id !== undefined ? d.db_id : d.label;
        nodes.push({ data: {
          id: 'cluster:' + s, isCluster: true, label: String(name), db_id: d.db_id,
          type: (d.type || '') + ' cluster', members: clusters[s] + 1,
          color: d.color || '#4f8cc9'
        } });
      });
      raw.nodes.forEach(function (n) {
        var d = Object.assign({}, n.data);
        var owner = clusters[d.id] ? d.id : parentOf[d.id];
        if (owner !== undefined) d.parent = 'cluster:' + owner;
        nodes.push({ data: d });
      });
      var edges = raw.edges.map(function (e) {
        var d = Object.assign({}, e.data);
        if (groupBy && d.label === groupBy) d.grouping = true;
        return { data: d };
      });
      return { nodes: nodes, edges: edges };
    }

    function draw() {
      var groupBy = groupSel.value;
      var els = buildElements(groupBy);
      var clusterCount = els.nodes.length - raw.nodes.length;
      var prefix = raw.pinned ? 'Query result: ' : '';
      statusEl.textContent = prefix + raw.nodes.length + ' nodes, ' + raw.edges.length + ' edges' +
        (clusterCount ? ', ' + clusterCount + ' groups' : '');
      if (raw.skippedEdges) {
        var omitted = document.createElement('div');
        omitted.className = 'k';
        omitted.textContent = raw.skippedEdges + ' relationship' +
          (raw.skippedEdges === 1 ? '' : 's') +
          ' not drawn because one or both endpoints were not returned by the query.';
        statusEl.appendChild(omitted);
      }
      if (raw.truncated && raw.truncated.length) {
        var warn = document.createElement('div');
        warn.className = 'error';
        warn.textContent = 'Showing only the first ' + raw.limit + ' rows of: ' + raw.truncated.join(', ') +
          '. Increase the kuzuExplorer.graphLimit setting to see everything.';
        statusEl.appendChild(warn);
      }
      detailsEl.className = 'k'; detailsEl.textContent = 'Select a node or edge.';
      if (cy) { cy.destroy(); cy = null; paintClusters(); }
      try {
        cy = cytoscape({
          container: cyEl,
          elements: els,
          wheelSensitivity: 0.3,
          style: [
            { selector: 'node', style: {
              'background-color': 'data(color)', 'label': 'data(label)', 'color': '#fff',
              'font-size': 9, 'text-valign': 'center', 'text-halign': 'center',
              'text-outline-color': '#000', 'text-outline-width': 1.5,
              'width': 28, 'height': 28 } },
            { selector: 'node[?isCluster]', style: {
              'background-opacity': 0, 'border-width': 0, 'label': '',
              'padding': '12px' } },
            { selector: 'edge', style: {
              'width': 1.5, 'line-color': '#999', 'target-arrow-color': '#999',
              'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
              'label': 'data(label)', 'font-size': 7, 'color': '#bbb' } },
            { selector: 'edge[?grouping]', style: {
              'width': 1, 'opacity': 0.35, 'label': '', 'target-arrow-shape': 'none' } },
            { selector: ':selected', style: { 'background-color': '#e0a458', 'line-color': '#e0a458', 'target-arrow-color': '#e0a458' } },
            { selector: 'node[?isCluster]:selected', style: { 'background-opacity': 0 } }
          ],
          layout: { name: 'null' }
        });
      } catch (err) {
        detailsEl.className = 'error';
        detailsEl.textContent = 'Failed to render graph: ' + (err && err.message ? err.message : String(err));
        return;
      }
      cy.on('render', paintClusters);
      runLayout();
      cy.on('tap', 'node', function (evt) { showDetails(evt.target.data()); });
      cy.on('tap', 'edge', function (evt) { showDetails(evt.target.data()); });
      cy.on('tap', function (evt) { if (evt.target === cy) { detailsEl.className = 'k'; detailsEl.textContent = 'Select a node or edge.'; } });
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (msg.type === 'loading') { statusEl.textContent = 'Loading…'; }
      else if (msg.type === 'graph') {
        if (typeof cytoscape === 'undefined') { statusEl.textContent = 'cytoscape failed to load'; return; }
        raw = {
          nodes: msg.nodes,
          edges: msg.edges,
          truncated: msg.truncated,
          limit: msg.limit,
          skippedEdges: msg.skippedEdges || 0,
          pinned: !!msg.pinned
        };
        populateGroupBy();
        draw();
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

/** Build the graph message consumed by the Cytoscape webview. */
export function graphMessage(graph: GraphResult, pinned = false): Record<string, any> {
  return {
    type: "graph",
    nodes: graph.nodes,
    edges: graph.edges,
    truncated: graph.truncated ?? [],
    limit: graph.limit,
    skippedEdges: graph.skippedEdges ?? 0,
    pinned,
  };
}

/**
 * Wire a webview to the sampled whole-database graph.
 *
 * The disposed guard matters when the panel is switched to a pinned query
 * result while an expensive whole-database graph() call is still in flight.
 */
export function attachGraph(
  webview: vscode.Webview,
  client: KuzuClient,
  graphLimit: number
): vscode.Disposable {
  let disposed = false;

  const load = async () => {
    if (disposed) return;
    void webview.postMessage({ type: "loading" });
    try {
      const graph = await client.graph(graphLimit);
      if (!disposed) {
        void webview.postMessage(graphMessage(graph));
      }
    } catch (e: any) {
      if (!disposed) {
        void webview.postMessage({ type: "error", message: e?.message ?? String(e) });
      }
    }
  };

  const subscription = webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "ready" || msg?.type === "reload") {
      await load();
    }
  });

  return new vscode.Disposable(() => {
    disposed = true;
    subscription.dispose();
  });
}

/**
 * Wire the graph webview to a fixed query-result payload.
 * Reload means redraw the same payload; it never rescans the database.
 */
export function attachStaticGraph(
  webview: vscode.Webview,
  graph: GraphResult
): vscode.Disposable {
  return webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "ready" || msg?.type === "reload") {
      void webview.postMessage(graphMessage(graph, true));
    }
  });
}
