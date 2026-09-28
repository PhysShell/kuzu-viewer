import * as vscode from "vscode";
import { KuzuClient } from "./kuzuClient";
import { graphHtml, attachGraph } from "./webviewGraph";

type ConnectFn = (dbPath: string, readOnly: boolean) => Promise<{ message: string }>;

class KuzuDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    /* no resources held per-document; the shared client owns the connection */
  }
}

/**
 * Opens a Kuzu database file as a graph view. Connects the shared client to the
 * file (read-only) and renders the graph in the editor's webview.
 */
export class KuzuDbEditorProvider implements vscode.CustomReadonlyEditorProvider<KuzuDocument> {
  public static readonly viewType = "kuzuExplorer.dbEditor";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: KuzuClient,
    private readonly connect: ConnectFn
  ) {}

  openCustomDocument(uri: vscode.Uri): KuzuDocument {
    return new KuzuDocument(uri);
  }

  async resolveCustomEditor(
    document: KuzuDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "node_modules", "cytoscape", "dist")],
    };

    try {
      const res = await this.connect(document.uri.fsPath, true);
      vscode.window.showInformationMessage(res.message);
    } catch (e: any) {
      webviewPanel.webview.html = this.errorHtml(e?.message ?? String(e));
      return;
    }

    const graphLimit = vscode.workspace.getConfiguration("kuzuExplorer").get<number>("graphLimit", 2000);
    webviewPanel.webview.html = graphHtml(webviewPanel.webview, this.extensionUri);
    const sub = attachGraph(webviewPanel.webview, this.client, graphLimit);
    webviewPanel.onDidDispose(() => sub.dispose());
  }

  private errorHtml(message: string): string {
    const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-errorForeground); padding: 16px;">
      <h3>Could not open Kuzu database</h3><pre style="white-space: pre-wrap;">${safe}</pre></body></html>`;
  }
}
