import * as vscode from "vscode";
import { GraphResult, KuzuClient } from "../kuzuClient";
import { graphHtml, attachGraph, attachStaticGraph, graphMessage } from "../webviewGraph";

/**
 * Standalone webview panel that renders a graph with Cytoscape.
 *
 * Two contents share the one panel:
 *  - the whole database, sampled per table up to `kuzuExplorer.graphLimit`;
 *  - a pinned payload: the subgraph a Cypher query returned.
 * Switching between them replaces only the data source, not the panel, so the
 * Cytoscape view (and its layout controls) is reused either way.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  public static readonly viewType = "kuzuExplorer.graph";
  private static readonly databaseTitle = "Kuzu Graph";
  private static readonly resultTitle = "Kuzu Graph — query result";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly graphLimit: number;
  /** Subscription feeding the webview; disposed when the content is swapped. */
  private graphSub: vscode.Disposable | undefined;
  private pinned = false;

  /** Show (or reveal) the panel with the whole-database graph. */
  static show(client: KuzuClient, extensionUri: vscode.Uri): GraphPanel {
    const column = vscode.ViewColumn.Active;
    if (GraphPanel.current) {
      const existing = GraphPanel.current;
      existing.panel.reveal(column);
      existing.showDatabaseGraph();
      return existing;
    }
    return GraphPanel.create(client, extensionUri);
  }

  /**
   * Show (or reveal) the panel with the subgraph extracted from a query result.
   * Nothing is read back from the database: the payload is already in hand.
   */
  static showResult(
    graph: GraphResult,
    client: KuzuClient,
    extensionUri: vscode.Uri,
    title: string = GraphPanel.resultTitle
  ): GraphPanel {
    const instance = GraphPanel.current ?? GraphPanel.create(client, extensionUri);
    instance.panel.reveal(vscode.ViewColumn.Active);
    instance.graphSub?.dispose();
    instance.pinned = true;
    instance.panel.title = title;
    instance.graphSub = attachStaticGraph(instance.panel.webview, graph);
    // Post straight away for an already-live webview; a fresh one asks for it
    // with `ready`, which the subscription above answers.
    void instance.panel.webview.postMessage(graphMessage(graph, true));
    return instance;
  }

  private static create(client: KuzuClient, extensionUri: vscode.Uri): GraphPanel {
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      GraphPanel.databaseTitle,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "node_modules", "cytoscape", "dist")],
      }
    );
    GraphPanel.current = new GraphPanel(panel, client, extensionUri);
    return GraphPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly client: KuzuClient,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.graphLimit = vscode.workspace.getConfiguration("kuzuExplorer").get<number>("graphLimit", 2000);
    this.panel.webview.html = graphHtml(this.panel.webview, extensionUri);
    this.graphSub = attachGraph(this.panel.webview, this.client, this.graphLimit);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Swap back to the whole-database graph and reload it. */
  private showDatabaseGraph(): void {
    if (this.pinned) {
      this.graphSub?.dispose();
      this.graphSub = attachGraph(this.panel.webview, this.client, this.graphLimit);
      this.pinned = false;
      this.panel.title = GraphPanel.databaseTitle;
    }
    void this.panel.webview.postMessage({ type: "reload" });
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.graphSub?.dispose();
    this.graphSub = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
