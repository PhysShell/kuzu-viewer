import * as vscode from "vscode";
import { GraphResult, KuzuClient } from "../kuzuClient";
import { attachGraph, attachStaticGraph, graphHtml, graphMessage } from "../webviewGraph";

/**
 * Standalone Cytoscape panel.
 *
 * The same panel can show either the sampled whole database or a pinned
 * subgraph extracted from one Cypher query result.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  public static readonly viewType = "kuzuExplorer.graph";
  private static readonly databaseTitle = "Kuzu Graph";
  private static readonly resultTitle = "Kuzu Graph — query result";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly graphLimit: number;
  private graphSub: vscode.Disposable | undefined;
  private pinned = false;
  private disposed = false;

  /** Show (or switch back to) the sampled whole-database graph. */
  static show(client: KuzuClient, extensionUri: vscode.Uri): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(vscode.ViewColumn.Active);
      GraphPanel.current.showDatabaseGraph();
      return GraphPanel.current;
    }

    const instance = GraphPanel.create(client, extensionUri);
    instance.panel.reveal(vscode.ViewColumn.Active);
    return instance;
  }

  /** Show only the subgraph already extracted from a query result. */
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

    // Existing webviews are already ready, so paint immediately. A newly
    // created/restored webview also requests the payload with its ready message.
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
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "node_modules", "cytoscape", "dist"),
        ],
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
    this.graphLimit = vscode.workspace
      .getConfiguration("kuzuExplorer")
      .get<number>("graphLimit", 2000);

    this.panel.webview.html = graphHtml(this.panel.webview, extensionUri);
    this.graphSub = attachGraph(this.panel.webview, this.client, this.graphLimit);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    GraphPanel.current = undefined;
    this.graphSub?.dispose();
    this.graphSub = undefined;

    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }

    this.panel.dispose();
  }
}
