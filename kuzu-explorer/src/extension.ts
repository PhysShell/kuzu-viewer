import * as vscode from "vscode";
import * as path from "path";
import { KuzuClient } from "./kuzuClient";
import { SchemaProvider } from "./schemaProvider";
import { QueryPanel } from "./panels/queryPanel";
import { GraphPanel } from "./panels/graphPanel";
import { KuzuDbEditorProvider } from "./dbEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Kuzu Explorer");
  const client = new KuzuClient(context.extensionPath, output);
  const schemaProvider = new SchemaProvider(client);

  context.subscriptions.push(output, client);

  const treeView = vscode.window.createTreeView("kuzuExplorer.database", {
    treeDataProvider: schemaProvider,
  });
  context.subscriptions.push(treeView);

  const setConnected = (connected: boolean) => {
    void vscode.commands.executeCommand("setContext", "kuzuExplorer.connected", connected);
  };
  setConnected(false);

  const updateTitle = () => {
    if (client.isConnected && client.databasePath) {
      const base = path.basename(client.databasePath);
      treeView.description = `${base}${client.readOnly ? " (read-only)" : " (read-write)"}`;
    } else {
      treeView.description = undefined;
    }
  };

  // Shared connect routine used by the Connect command, the custom editor, and
  // the "Open as Kuzu Database" context-menu command.
  const connectTo = async (dbPath: string, readOnly: boolean) => {
    const res = await client.connect(dbPath, readOnly);
    setConnected(true);
    updateTitle();
    schemaProvider.refresh();
    return res;
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      KuzuDbEditorProvider.viewType,
      new KuzuDbEditorProvider(context.extensionUri, client, connectTo),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kuzuExplorer.connect", async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const dbPath = await vscode.window.showInputBox({
        title: "Connect to Kuzu Database",
        prompt: "Absolute path to the Kuzu database file or directory",
        value: wsFolder,
        ignoreFocusOut: true,
        validateInput: (v) => (v && v.trim() ? null : "Path is required"),
      });
      if (!dbPath) {
        return;
      }
      const defaultReadOnly = vscode.workspace
        .getConfiguration("kuzuExplorer")
        .get<boolean>("defaultReadOnly", true);
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Read-only", description: "Does not lock the DB for other writers (recommended)", ro: true },
          { label: "Read-write", description: "Allows write queries; takes an exclusive lock", ro: false },
        ],
        { title: "Connection mode", placeHolder: defaultReadOnly ? "Read-only" : "Read-write" }
      );
      if (!pick) {
        return;
      }
      await vscode.window.withProgress(
        { location: { viewId: "kuzuExplorer.database" }, title: "Connecting…" },
        async () => {
          try {
            const res = await connectTo(dbPath.trim(), pick.ro);
            vscode.window.showInformationMessage(res.message);
          } catch (e: any) {
            setConnected(false);
            vscode.window.showErrorMessage(`Kuzu: ${e?.message ?? String(e)}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand("kuzuExplorer.disconnect", async () => {
      await client.disconnect();
      setConnected(false);
      updateTitle();
      schemaProvider.clear();
      vscode.window.showInformationMessage("Kuzu: disconnected.");
    }),

    vscode.commands.registerCommand("kuzuExplorer.refresh", () => {
      schemaProvider.refresh();
    }),

    vscode.commands.registerCommand("kuzuExplorer.runQuery", () => {
      if (!client.isConnected) {
        vscode.window.showWarningMessage("Kuzu: connect to a database first.");
        return;
      }
      QueryPanel.show(client, context.extensionUri);
    }),

    vscode.commands.registerCommand("kuzuExplorer.openTable", (arg?: unknown) => {
      // Invoked either by a tree-item click (arg = table name string) or by the
      // inline/context menu (arg = the TableItem node). Resolve both.
      const name =
        typeof arg === "string"
          ? arg
          : (arg as any)?.table?.name ?? (arg as any)?.tableName;
      if (!client.isConnected || !name) {
        return;
      }
      const panel = QueryPanel.show(client, context.extensionUri);
      void panel.showTable(name);
    }),

    vscode.commands.registerCommand("kuzuExplorer.showGraph", () => {
      if (!client.isConnected) {
        vscode.window.showWarningMessage("Kuzu: connect to a database first.");
        return;
      }
      GraphPanel.show(client, context.extensionUri);
    }),

    vscode.commands.registerCommand("kuzuExplorer.visualizeResult", () => {
      if (!client.isConnected) {
        vscode.window.showWarningMessage("Kuzu: connect to a database first.");
        return;
      }
      if (!QueryPanel.visualizeLastResult()) {
        vscode.window.showInformationMessage(
          "Kuzu: run a query that returns drawable graph entities first."
        );
      }
    }),

    vscode.commands.registerCommand("kuzuExplorer.openDatabaseFile", async (uri?: vscode.Uri) => {
      const target = uri ?? (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false }))?.[0];
      if (!target) {
        return;
      }
      try {
        const res = await connectTo(target.fsPath, true);
        vscode.window.showInformationMessage(res.message);
        await vscode.commands.executeCommand("kuzuExplorer.database.focus");
        GraphPanel.show(client, context.extensionUri);
      } catch (e: any) {
        setConnected(false);
        vscode.window.showErrorMessage(`Kuzu: ${e?.message ?? String(e)}`);
      }
    })
  );
}

export function deactivate(): void {
  // KuzuClient is disposed via context.subscriptions, which tears down the worker.
}
