import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";

export interface SchemaProperty {
  propertyId: number | null;
  name: string;
  type: string;
  primaryKey: boolean;
}

export interface SchemaTable {
  name: string;
  type: string; // "NODE" | "REL"
  properties: SchemaProperty[];
}

export interface ConnectResult {
  message: string;
  readOnly: boolean;
  tempCopy: boolean;
  path: string;
}

export interface QueryResult {
  columns: string[];
  rows: any[];
}

export interface TableResult extends QueryResult {
  kind: "NODE" | "REL";
}

export interface GraphResult {
  nodes: Array<{ data: Record<string, any> }>;
  edges: Array<{ data: Record<string, any> }>;
  /** Tables whose row count reached the limit (graph shows only a sample). */
  truncated?: string[];
  limit?: number;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

/**
 * Owns the Node worker subprocess that holds the Kuzu connection and exchanges
 * newline-delimited JSON-RPC messages with it.
 */
export class KuzuClient implements vscode.Disposable {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private connected = false;
  private currentPath: string | null = null;
  private currentReadOnly = false;

  constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get databasePath(): string | null {
    return this.currentPath;
  }

  get readOnly(): boolean {
    return this.currentReadOnly;
  }

  private nodeExecutable(): string {
    const configured = vscode.workspace
      .getConfiguration("kuzuExplorer")
      .get<string>("nodePath");
    return configured && configured.trim() ? configured.trim() : "node";
  }

  private ensureWorker(): void {
    if (this.proc) {
      return;
    }
    const workerPath = path.join(this.extensionPath, "worker", "dbWorker.js");
    const node = this.nodeExecutable();
    this.output.appendLine(`[client] spawning worker: ${node} ${workerPath}`);
    const proc = spawn(node, [workerPath], {
      cwd: this.extensionPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.on("error", (err) => {
      this.output.appendLine(`[client] worker spawn error: ${err.message}`);
      this.failAll(
        `Could not start the Kuzu worker with '${node}'. ` +
          `Set 'kuzuExplorer.nodePath' to a valid Node.js executable. (${err.message})`
      );
      this.teardown();
    });

    proc.on("exit", (code, signal) => {
      this.output.appendLine(`[client] worker exited code=${code} signal=${signal}`);
      this.failAll(`Kuzu worker exited (code=${code}, signal=${signal}).`);
      this.teardown();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString());
    });

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Non-protocol output from the worker/native lib; log and skip.
      this.output.appendLine(`[worker stdout] ${trimmed}`);
      return;
    }
    if (typeof msg.id === "undefined") {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error || "Unknown worker error"));
    }
  }

  private failAll(reason: string): void {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private teardown(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.proc = null;
    this.connected = false;
  }

  private rpc<T>(method: string, params: Record<string, any> = {}): Promise<T> {
    this.ensureWorker();
    if (!this.proc) {
      return Promise.reject(new Error("Kuzu worker is not running."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params }) + "\n";
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async connect(dbPath: string, readOnly: boolean): Promise<ConnectResult> {
    const result = await this.rpc<ConnectResult>("connect", { path: dbPath, readOnly });
    this.connected = true;
    this.currentPath = result.path ?? dbPath;
    this.currentReadOnly = result.readOnly;
    return result;
  }

  async disconnect(): Promise<void> {
    if (!this.proc) {
      this.connected = false;
      return;
    }
    try {
      await this.rpc<{ message: string }>("disconnect");
    } finally {
      this.connected = false;
      this.currentPath = null;
      this.currentReadOnly = false;
    }
  }

  schema(): Promise<{ schema: SchemaTable[] }> {
    return this.rpc("schema");
  }

  table(name: string, limit: number): Promise<TableResult> {
    return this.rpc("table", { name, limit });
  }

  query(query: string): Promise<QueryResult> {
    return this.rpc("query", { query });
  }

  graph(limit: number): Promise<GraphResult> {
    return this.rpc("graph", { limit });
  }

  dispose(): void {
    this.failAll("Extension is shutting down.");
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc.kill();
    }
    this.teardown();
  }
}
