import * as vscode from "vscode";
import { KuzuClient } from "../kuzuClient";
import { graphHtml, attachGraph } from "../webviewGraph";

/** Standalone webview panel that renders the whole graph with Cytoscape. */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  public static readonly viewType = "kuzuExplorer.graph";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(client: KuzuClient, extensionUri: vscode.Uri): GraphPanel {
    const column = vscode.ViewColumn.Active;
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(column);
      void GraphPanel.current.panel.webview.postMessage({ type: "reload" });
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      "Kuzu Graph",
      column,
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
    client: KuzuClient,
    extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    const graphLimit = vscode.workspace.getConfiguration("kuzuExplorer").get<number>("graphLimit", 500);
    this.panel.webview.html = graphHtml(this.panel.webview, extensionUri);
    this.disposables.push(attachGraph(this.panel.webview, client, graphLimit));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
