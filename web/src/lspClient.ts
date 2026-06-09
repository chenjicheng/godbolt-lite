import type * as Monaco from "monaco-editor";
import {
  completionItemsFromLsp,
  definitionsFromLsp,
  hoverFromLsp,
  lspDiagnosticToMarker,
  maxLspListItems,
  semanticTokenDataValues,
  semanticTokenModifiers,
  semanticTokenLegendValues,
  semanticTokenTypes,
  toLspPosition
} from "./lspConverters";

type MonacoApi = typeof Monaco;
type MonacoEditor = Monaco.editor.IStandaloneCodeEditor;
type Model = Monaco.editor.ITextModel;

interface LspClientOptions {
  monaco: MonacoApi;
  editor: MonacoEditor;
  languageId: string;
  rootUri: string;
  getModels: () => Model[];
  onStatus: (status: string) => void;
}

export interface LspHandle {
  dispose: () => void;
  definition: (model: Model, position: Monaco.Position) => Promise<Monaco.languages.Location[]>;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const owner = "lsp";
const reconnectDelayMs = 1500;
const requestTimeoutMs = 10000;
const maxLspClientPayloadBytes = 8 << 20;
const maxLspDocumentTextLength = maxLspClientPayloadBytes;
const maxSemanticTokenValues = 250000;
const textEncoder = new TextEncoder();

export function attachLspClient(options: LspClientOptions): LspHandle {
  const { monaco, editor, languageId, rootUri, getModels, onStatus } = options;
  const pending = new Map<number, PendingRequest>();
  const disposables: Monaco.IDisposable[] = [];
  let socket: WebSocket | undefined;
  let requestId = 1;
  let reconnectTimer: number | undefined;
  let stopped = false;
  let initialized = false;
  let semanticTokensDisposable: Monaco.IDisposable | undefined;
  const watchedModels = new WeakSet<Model>();
  const openedUris = new Set<string>();
  const oversizedUris = new Set<string>();

  const uriForModel = (model: Model) => model.uri.toString();

  function connect() {
    if (stopped) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${window.location.host}/api/lsp`);
    onStatus("LSP connecting");

    socket.addEventListener("open", () => {
      initialized = false;
      openedUris.clear();
      onStatus("LSP initializing");
      request("initialize", {
        processId: null,
        rootUri,
        capabilities: {
          textDocument: {
            completion: { completionItem: { snippetSupport: true } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            publishDiagnostics: { relatedInformation: true },
            semanticTokens: {
              dynamicRegistration: false,
              requests: { full: true, range: false },
              tokenTypes: semanticTokenTypes,
              tokenModifiers: semanticTokenModifiers,
              formats: ["relative"],
              overlappingTokenSupport: false,
              multilineTokenSupport: true
            }
          }
        },
        workspaceFolders: [{ uri: rootUri, name: "mini-godbolt-project" }]
      })
        .then((result) => {
          initialized = true;
          sendNotification("initialized", {});
          configureSemanticTokens(result);
          for (const model of getModels()) {
            watchModel(model);
            openDocument(model);
          }
          onStatus("LSP connected");
        })
        .catch((error) => {
          onStatus(`LSP initialize failed: ${error.message}`);
          socket?.close(1011, "LSP initialize failed");
        });
    });

    socket.addEventListener("message", (event) => {
      handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      initialized = false;
      rejectPending("LSP disconnected");
      if (!stopped) {
        onStatus("LSP disconnected, retrying");
        reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
      }
    });

    socket.addEventListener("error", () => {
      onStatus("LSP socket error");
    });
  }

  function handleMessage(raw: unknown) {
    if (typeof raw !== "string") {
      return;
    }
    if (textEncoder.encode(raw).length > maxLspClientPayloadBytes) {
      onStatus("LSP message too large");
      socket?.close(1009, "LSP message too large");
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === "number" && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (!request) return;
      window.clearTimeout(request.timeoutId);
      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      applyDiagnostics(message.params);
      return;
    }

    if (message.id !== undefined && message.method) {
      sendErrorResponse(message.id, -32601, `Unsupported LSP request: ${message.method}`);
    }
  }

  function request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("LSP is not connected"));
    }
    if (!initialized && method !== "initialize") {
      return Promise.reject(new Error("LSP is not initialized"));
    }

    const id = requestId;
    requestId += 1;

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    if (!sendJsonMessage(message)) {
      return Promise.reject(new Error(`${method} message is too large for the LSP bridge`));
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, requestTimeoutMs);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });
    });
  }

  function sendNotification(method: string, params: unknown) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendJsonMessage({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  function sendErrorResponse(id: number | string, code: number, message: string) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    sendJsonMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message }
    });
  }

  function sendJsonMessage(message: JsonRpcMessage): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const raw = JSON.stringify(message);
    if (textEncoder.encode(raw).length > maxLspClientPayloadBytes) {
      return false;
    }
    socket.send(raw);
    return true;
  }

  function openDocument(model: Model) {
    if (!initialized || model.getLanguageId() !== languageId) {
      return;
    }

    const uri = uriForModel(model);
    if (openedUris.has(uri)) {
      changeDocument(model);
      return;
    }

    if (!canSendDocumentText(uri, model)) {
      return;
    }

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId,
          version: model.getVersionId(),
          text: model.getValue()
        }
      }
    };
    if (!sendDocumentMessage(uri, model, message)) {
      return;
    }
    openedUris.add(uri);
  }

  function watchModel(model: Model) {
    if (watchedModels.has(model)) return;
    watchedModels.add(model);
    disposables.push(model.onDidChangeContent(() => changeDocument(model)));
    disposables.push(
      model.onWillDispose(() => {
        const uri = uriForModel(model);
        if (!openedUris.has(uri)) return;
        sendNotification("textDocument/didClose", {
          textDocument: { uri }
        });
        openedUris.delete(uri);
      })
    );
  }

  function changeDocument(model: Model) {
    if (!initialized || model.getLanguageId() !== languageId) {
      return;
    }

    const uri = uriForModel(model);
    if (!openedUris.has(uri)) {
      openDocument(model);
      return;
    }

    if (!canSendDocumentText(uri, model)) {
      closeDocument(uri);
      return;
    }

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: {
          uri,
          version: model.getVersionId()
        },
        contentChanges: [{ text: model.getValue() }]
      }
    };
    if (!sendDocumentMessage(uri, model, message)) {
      closeDocument(uri);
    }
  }

  function canSendDocumentText(uri: string, model: Model): boolean {
    if (model.getValueLength() <= maxLspDocumentTextLength) {
      return true;
    }
    markOversizedDocument(uri, model);
    return false;
  }

  function closeDocument(uri: string): void {
    if (!openedUris.has(uri)) return;
    sendNotification("textDocument/didClose", {
      textDocument: { uri }
    });
    openedUris.delete(uri);
  }

  function sendDocumentMessage(uri: string, model: Model, message: JsonRpcMessage): boolean {
    if (sendJsonMessage(message)) {
      if (oversizedUris.delete(uri)) {
        onStatus("LSP connected");
      }
      return true;
    }
    markOversizedDocument(uri, model);
    return false;
  }

  function markOversizedDocument(uri: string, model: Model): void {
    oversizedUris.add(uri);
    monaco.editor.setModelMarkers(model, owner, []);
    onStatus("LSP disabled for oversized file");
  }

  function applyDiagnostics(params: unknown) {
    if (!params || typeof params !== "object") {
      return;
    }

    const record = params as Record<string, unknown>;
    const uri = typeof record.uri === "string" ? record.uri : undefined;
    const model = uri ? monaco.editor.getModel(monaco.Uri.parse(uri)) : undefined;
    const diagnostics = Array.isArray(record.diagnostics)
      ? record.diagnostics.slice(0, maxLspListItems)
      : [];

    if (!model) {
      return;
    }

    monaco.editor.setModelMarkers(
      model,
      owner,
      diagnostics.map((diagnostic) => lspDiagnosticToMarker(monaco, diagnostic))
    );
  }

  function rejectPending(message: string) {
    for (const item of pending.values()) {
      window.clearTimeout(item.timeoutId);
      item.reject(new Error(message));
    }
    pending.clear();
  }

  disposables.push(
    monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: [".", ">", ":", "#", "<", "\"", "/"],
      async provideCompletionItems(model, position) {
        try {
          const result = await request("textDocument/completion", {
            textDocument: { uri: uriForModel(model) },
            position: toLspPosition(position)
          });

          return {
            suggestions: completionItemsFromLsp(monaco, model, position, result)
          };
        } catch {
          return { suggestions: [] };
        }
      }
    }),
    monaco.languages.registerHoverProvider(languageId, {
      async provideHover(model, position) {
        try {
          const result = await request("textDocument/hover", {
            textDocument: { uri: uriForModel(model) },
            position: toLspPosition(position)
          });
          return hoverFromLsp(monaco, result);
        } catch {
          return null;
        }
      }
    }),
    monaco.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(model, position) {
        try {
          const result = await request("textDocument/definition", {
            textDocument: { uri: uriForModel(model) },
            position: toLspPosition(position)
          });
          return definitionsFromLsp(monaco, result);
        } catch {
          return [];
        }
      }
    }),
    editor.onDidChangeModel((event) => {
      const nextModel = event.newModelUrl ? monaco.editor.getModel(event.newModelUrl) : undefined;
      if (nextModel) {
        watchModel(nextModel);
        openDocument(nextModel);
      }
    }),
    monaco.editor.onDidCreateModel((model) => {
      if (model.getLanguageId() === languageId) {
        watchModel(model);
        openDocument(model);
      }
    })
  );

  for (const model of getModels()) {
    watchModel(model);
  }

  connect();

  async function definition(model: Model, position: Monaco.Position): Promise<Monaco.languages.Location[]> {
    const result = await request("textDocument/definition", {
      textDocument: { uri: uriForModel(model) },
      position: toLspPosition(position)
    });
    return definitionsFromLsp(monaco, result);
  }

  function configureSemanticTokens(initResult: unknown) {
    const result = initResult && typeof initResult === "object" ? (initResult as Record<string, unknown>) : {};
    const capabilities =
      result.capabilities && typeof result.capabilities === "object"
        ? (result.capabilities as Record<string, unknown>)
        : {};
    const provider =
      capabilities.semanticTokensProvider && typeof capabilities.semanticTokensProvider === "object"
        ? (capabilities.semanticTokensProvider as Record<string, unknown>)
        : undefined;
    const legend =
      provider?.legend && typeof provider.legend === "object"
        ? (provider.legend as Record<string, unknown>)
        : undefined;
    const tokenTypes = semanticTokenLegendValues(legend?.tokenTypes, semanticTokenTypes);
    const tokenModifiers = semanticTokenLegendValues(legend?.tokenModifiers, semanticTokenModifiers);

    semanticTokensDisposable?.dispose();
    semanticTokensDisposable = monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
      getLegend: () => ({ tokenTypes, tokenModifiers }),
      async provideDocumentSemanticTokens(model) {
        try {
          const response = await request("textDocument/semanticTokens/full", {
            textDocument: { uri: uriForModel(model) }
          });
          const data = response && typeof response === "object" ? (response as Record<string, unknown>).data : undefined;
          return {
            data: semanticTokenDataValues(data, maxSemanticTokenValues)
          };
        } catch {
          return { data: new Uint32Array() };
        }
      },
      releaseDocumentSemanticTokens: () => undefined
    });
    disposables.push(semanticTokensDisposable);
  }

  return {
    dispose: () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      for (const uri of openedUris) {
        sendNotification("textDocument/didClose", {
          textDocument: { uri }
        });
      }
      openedUris.clear();
      rejectPending("LSP disposed");
      for (const disposable of disposables) {
        disposable.dispose();
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendNotification("shutdown", null);
        socket.close();
      } else {
        socket?.close();
      }
    },
    definition
  };
}
