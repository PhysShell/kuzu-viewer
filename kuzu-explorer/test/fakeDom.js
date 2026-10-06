"use strict";
/*
 * A very small DOM/VS Code harness so the webview scripts and the panel classes
 * can be executed outside VS Code. Only what these two webviews touch is
 * implemented; anything else throws loudly rather than silently passing.
 */

const vm = require("node:vm");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function ctx2d() {
  const noop = () => {};
  return {
    setTransform: noop,
    clearRect: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
}

function makeElement(tag, id) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || "",
    children: [],
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    value: "",
    _text: "",
    _html: "",
    _listeners: {},
    classList: {
      _set: new Set(),
      add(...c) {
        c.forEach((x) => this._set.add(x));
      },
      remove(...c) {
        c.forEach((x) => this._set.delete(x));
      },
      contains(c) {
        return this._set.has(c);
      },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c);
        else this._set.delete(c);
        return on;
      },
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    addEventListener(type, fn) {
      (this._listeners[type] || (this._listeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event) {
      (this._listeners[type] || []).forEach((fn) => fn(event || {}));
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0, x: 0, y: 0 };
    },
    getContext() {
      return ctx2d();
    },
    focus() {},
  };
  Object.defineProperty(el, "textContent", {
    get() {
      return this._text;
    },
    set(v) {
      this._text = String(v);
      this.children = [];
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() {
      return this._html;
    },
    set(v) {
      this._html = String(v);
      this.children = [];
    },
  });
  return el;
}

/**
 * Build a window/document pair with the given element ids pre-created.
 * `messages` collects everything the webview script posts to the extension.
 */
function createDom(ids, state = {}) {
  const elements = {};
  ids.forEach((id) => {
    elements[id] = makeElement("div", id);
  });
  const document = {
    body: makeElement("body"),
    documentElement: makeElement("html"),
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => elements[id] || null,
    addEventListener() {},
  };
  const messages = [];
  const windowListeners = {};
  const sandbox = {
    document,
    elements,
    messages,
    console,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
    Date,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout,
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 1,
      addEventListener(type, fn) {
        (windowListeners[type] || (windowListeners[type] = [])).push(fn);
      },
      removeEventListener() {},
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({
      getPropertyValue: () => "",
      fontFamily: "sans-serif",
    }),
    acquireVsCodeApi: () => ({
      postMessage: (msg) => messages.push(msg),
      getState: () => state,
      setState: (next) => {
        state = next;
      },
    }),
  };
  sandbox.window.document = document;
  sandbox.globalThis = sandbox;
  return {
    sandbox,
    elements,
    messages,
    /** Deliver a message posted by the extension to the webview script. */
    post(msg) {
      (windowListeners.message || []).forEach((fn) => fn({ data: msg }));
    },
    /** Run a webview <script> body in the sandbox. */
    run(script) {
      vm.runInNewContext(script, sandbox, { filename: "webview.js" });
    },
    resize() {
      (windowListeners.resize || []).forEach((fn) => fn({}));
    },
  };
}

/** Pull the inline (non-src) script out of a webview HTML string. */
function inlineScript(html) {
  const matches = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const inline = matches.filter((m) => !/\bsrc=/.test(m[1]));
  if (inline.length !== 1) {
    throw new Error(`expected exactly one inline script, found ${inline.length}`);
  }
  return inline[0][2];
}

// ---------------------------------------------------------------------------
// Fake vscode module + webview panels
// ---------------------------------------------------------------------------

/** Webview panels created through the stubbed vscode.window.createWebviewPanel. */
const panels = [];

function makeWebview() {
  const webview = {
    html: "",
    cspSource: "https://csp.test",
    options: {},
    posted: [],
    handlers: [],
    asWebviewUri: (uri) => ({ toString: () => `https://webview.test/${uri.path}` }),
    onDidReceiveMessage(fn) {
      this.handlers.push(fn);
      return { dispose() {} };
    },
    postMessage(msg) {
      this.posted.push(msg);
      if (this.onPost) {
        this.onPost(msg);
      }
      return Promise.resolve(true);
    },
  };
  return webview;
}

const vscodeStub = {
  Uri: {
    joinPath: (base, ...parts) => {
      const p = [base && base.path ? base.path : String(base), ...parts].join("/");
      return { path: p, fsPath: p, toString: () => p };
    },
    file: (p) => ({ path: p, fsPath: p, toString: () => p }),
  },
  ViewColumn: { Active: -1, One: 1, Two: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  Disposable: class {
    constructor(fn) {
      this.fn = fn;
    }
    dispose() {
      if (this.fn) this.fn();
    }
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
    }),
  },
  window: {
    createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
    createTreeView: () => ({ dispose() {}, description: undefined }),
    registerCustomEditorProvider: () => ({ dispose() {} }),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    withProgress: async (_opts, task) => task(),
    createWebviewPanel(viewType, title, _column, options) {
      const panel = {
        viewType,
        title,
        options,
        webview: makeWebview(),
        visible: true,
        disposeHandlers: [],
        reveal() {
          this.visible = true;
        },
        onDidDispose(fn) {
          this.disposeHandlers.push(fn);
          return { dispose() {} };
        },
        dispose() {
          // Real panels fire onDidDispose once, and the panel classes call
          // dispose() from that handler — mirror that, or it recurses forever.
          if (this.disposed) {
            return;
          }
          this.disposed = true;
          this.disposeHandlers.forEach((fn) => fn());
        },
      };
      panels.push(panel);
      return panel;
    },
    informationMessages: [],
    warningMessages: [],
    showInformationMessage(msg) {
      vscodeStub.window.informationMessages.push(msg);
    },
    showWarningMessage(msg) {
      vscodeStub.window.warningMessages.push(msg);
    },
    showErrorMessage() {},
  },
  commands: {
    registered: [],
    registerCommand(id, fn) {
      vscodeStub.commands.registered.push({ id, fn });
      return { dispose() {} };
    },
    executeCommand: () => Promise.resolve(),
  },
};

/** Route `require("vscode")` to the stub for everything loaded afterwards. */
function installVscodeStub() {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return vscodeStub;
    }
    return original.apply(this, arguments);
  };
  return () => {
    Module._load = original;
  };
}

module.exports = { createDom, inlineScript, makeElement, installVscodeStub, panels, vscodeStub };
