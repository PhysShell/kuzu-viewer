import * as vscode from "vscode";
import { KuzuClient, SchemaTable, SchemaProperty } from "./kuzuClient";

type Node = GroupItem | TableItem | PropertyItem | InfoItem;

class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly kind: "NODE" | "REL",
    public readonly tables: SchemaTable[]
  ) {
    super(
      kind === "NODE" ? `Node Tables (${tables.length})` : `Rel Tables (${tables.length})`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = "kuzuGroup";
    this.iconPath = new vscode.ThemeIcon(kind === "NODE" ? "circle-large-outline" : "arrow-right");
  }
}

class TableItem extends vscode.TreeItem {
  constructor(public readonly table: SchemaTable) {
    super(table.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "kuzuTable";
    this.iconPath = new vscode.ThemeIcon(table.type === "NODE" ? "symbol-class" : "references");
    this.description = table.type;
    this.tooltip = `${table.name} (${table.type}) — ${table.properties.length} properties`;
    this.command = {
      command: "kuzuExplorer.openTable",
      title: "Open Table",
      arguments: [table.name],
    };
  }
}

class PropertyItem extends vscode.TreeItem {
  constructor(public readonly property: SchemaProperty) {
    super(property.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "kuzuProperty";
    this.description = `${property.type}${property.primaryKey ? "  🔑" : ""}`;
    this.iconPath = new vscode.ThemeIcon(property.primaryKey ? "key" : "symbol-field");
    this.tooltip = `${property.name}: ${property.type}${property.primaryKey ? " (primary key)" : ""}`;
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label: string, icon = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "kuzuInfo";
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class SchemaProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private schema: SchemaTable[] = [];
  private errorMessage: string | null = null;

  constructor(private readonly client: KuzuClient) {}

  refresh(): void {
    void this.load();
  }

  clear(): void {
    this.schema = [];
    this.errorMessage = null;
    this._onDidChangeTreeData.fire();
  }

  private async load(): Promise<void> {
    if (!this.client.isConnected) {
      this.schema = [];
      this.errorMessage = null;
      this._onDidChangeTreeData.fire();
      return;
    }
    try {
      const { schema } = await this.client.schema();
      this.schema = schema;
      this.errorMessage = null;
    } catch (e: any) {
      this.schema = [];
      this.errorMessage = e?.message ?? String(e);
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!this.client.isConnected) {
      return [];
    }
    if (!element) {
      // Root: lazily load schema if we have not yet.
      if (this.errorMessage) {
        return [new InfoItem(this.errorMessage, "error")];
      }
      if (this.schema.length === 0) {
        await this.load();
        if (this.errorMessage) {
          return [new InfoItem(this.errorMessage, "error")];
        }
      }
      const nodeTables = this.schema.filter((t) => t.type === "NODE");
      const relTables = this.schema.filter((t) => t.type === "REL");
      const groups: Node[] = [];
      if (nodeTables.length) groups.push(new GroupItem("NODE", nodeTables));
      if (relTables.length) groups.push(new GroupItem("REL", relTables));
      if (!groups.length) groups.push(new InfoItem("No tables in this database."));
      return groups;
    }
    if (element instanceof GroupItem) {
      return element.tables.map((t) => new TableItem(t));
    }
    if (element instanceof TableItem) {
      return element.table.properties.map((p) => new PropertyItem(p));
    }
    return [];
  }
}
