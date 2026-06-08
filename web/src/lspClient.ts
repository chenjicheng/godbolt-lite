import type * as Monaco from "monaco-editor";

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

  function handleMessage(raw: string) {
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

    const id = requestId;
    requestId += 1;

    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    socket.send(JSON.stringify(message));

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

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params
      })
    );
  }

  function sendErrorResponse(id: number | string, code: number, message: string) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message }
      })
    );
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

    openedUris.add(uri);
    sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: model.getVersionId(),
        text: model.getValue()
      }
    });
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

    sendNotification("textDocument/didChange", {
      textDocument: {
        uri,
        version: model.getVersionId()
      },
      contentChanges: [{ text: model.getValue() }]
    });
  }

  function applyDiagnostics(params: unknown) {
    if (!params || typeof params !== "object") {
      return;
    }

    const record = params as Record<string, unknown>;
    const uri = typeof record.uri === "string" ? record.uri : undefined;
    const model = uri ? monaco.editor.getModel(monaco.Uri.parse(uri)) : undefined;
    const diagnostics = Array.isArray(record.diagnostics) ? record.diagnostics : [];

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
    const tokenTypes = Array.isArray(legend?.tokenTypes) ? legend.tokenTypes.filter(isString) : semanticTokenTypes;
    const tokenModifiers = Array.isArray(legend?.tokenModifiers)
      ? legend.tokenModifiers.filter(isString)
      : semanticTokenModifiers;

    semanticTokensDisposable?.dispose();
    semanticTokensDisposable = monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
      getLegend: () => ({ tokenTypes, tokenModifiers }),
      async provideDocumentSemanticTokens(model) {
        try {
          const response = await request("textDocument/semanticTokens/full", {
            textDocument: { uri: uriForModel(model) }
          });
          const data = response && typeof response === "object" ? (response as Record<string, unknown>).data : undefined;
          return { data: new Uint32Array(Array.isArray(data) ? data.filter(isNumber) : []) };
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

function lspDiagnosticToMarker(monaco: MonacoApi, diagnostic: unknown): Monaco.editor.IMarkerData {
  const record = diagnostic && typeof diagnostic === "object" ? (diagnostic as Record<string, unknown>) : {};
  const range = record.range && typeof record.range === "object" ? (record.range as Record<string, unknown>) : {};
  const start = range.start && typeof range.start === "object" ? (range.start as Record<string, unknown>) : {};
  const end = range.end && typeof range.end === "object" ? (range.end as Record<string, unknown>) : {};
  const startLineNumber = numberField(start.line, 0) + 1;
  const startColumn = numberField(start.character, 0) + 1;
  const endLineNumber = numberField(end.line, startLineNumber - 1) + 1;
  const endColumn = numberField(end.character, startColumn) + 1;

  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    message: typeof record.message === "string" ? record.message : "LSP diagnostic",
    severity: markerSeverityFromLsp(monaco, record.severity)
  };
}

function completionItemsFromLsp(
  monaco: MonacoApi,
  model: Model,
  position: Monaco.Position,
  result: unknown
): Monaco.languages.CompletionItem[] {
  const rawItems = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).items)
      ? ((result as Record<string, unknown>).items as unknown[])
      : [];
  const word = model.getWordUntilPosition(position);
  const fallbackRange = new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn
  );

  return rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => {
      const edit = completionTextEditFromLsp(monaco, item.textEdit);
      const insertText = edit?.newText ?? String(item.insertText ?? item.label ?? "");
      return {
        label: String(item.label ?? item.insertText ?? "completion"),
        kind: completionKindFromLsp(monaco, item.kind),
        insertText,
        insertTextRules:
          item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        detail: typeof item.detail === "string" ? item.detail : undefined,
        documentation: documentationFromLsp(item.documentation),
        sortText: typeof item.sortText === "string" ? item.sortText : undefined,
        filterText: typeof item.filterText === "string" ? item.filterText : undefined,
        preselect: item.preselect === true,
        range: edit?.range ?? fallbackRange
      };
    });
}

function hoverFromLsp(monaco: MonacoApi, result: unknown): Monaco.languages.Hover | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const record = result as Record<string, unknown>;
  const contents = markupContentToMarkdown(record.contents);
  if (!contents.length) {
    return null;
  }

  return {
    contents,
    range: lspRangeToMonaco(monaco, record.range)
  };
}

function definitionsFromLsp(monaco: MonacoApi, result: unknown): Monaco.languages.Location[] {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  const locations: Monaco.languages.Location[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const targetUri = typeof item.targetUri === "string" ? item.targetUri : undefined;
    const uri = typeof item.uri === "string" ? item.uri : targetUri;
    const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
    if (!uri) continue;
    locations.push({
      uri: monaco.Uri.parse(uri),
      range: lspRangeToMonaco(monaco, range) ?? new monaco.Range(1, 1, 1, 1)
    });
  }
  return locations;
}

function toLspPosition(position: Monaco.Position) {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1
  };
}

function lspRangeToMonaco(monaco: MonacoApi, value: unknown): Monaco.Range | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const range = value as Record<string, unknown>;
  const start = range.start && typeof range.start === "object" ? (range.start as Record<string, unknown>) : {};
  const end = range.end && typeof range.end === "object" ? (range.end as Record<string, unknown>) : {};

  return new monaco.Range(
    numberField(start.line, 0) + 1,
    numberField(start.character, 0) + 1,
    numberField(end.line, 0) + 1,
    numberField(end.character, 0) + 1
  );
}

function completionTextEditFromLsp(
  monaco: MonacoApi,
  value: unknown
): { newText: string; range: Monaco.Range } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const edit = value as Record<string, unknown>;
  const newText = typeof edit.newText === "string" ? edit.newText : undefined;
  if (newText === undefined) {
    return undefined;
  }

  const range = lspRangeToMonaco(monaco, edit.range ?? edit.replace ?? edit.insert);
  if (!range) {
    return undefined;
  }

  return { newText, range };
}

function markupContentToMarkdown(value: unknown): Monaco.IMarkdownString[] {
  if (typeof value === "string") {
    return [{ value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap(markupContentToMarkdown);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") {
      const language = typeof record.language === "string" ? record.language : undefined;
      return [{ value: language ? `\`\`\`${language}\n${record.value}\n\`\`\`` : record.value }];
    }
  }

  return [];
}

function documentationFromLsp(value: unknown): Monaco.IMarkdownString | string | undefined {
  const docs = markupContentToMarkdown(value);
  if (!docs.length) {
    return undefined;
  }
  return docs[0];
}

function markerSeverityFromLsp(monaco: MonacoApi, value: unknown): Monaco.MarkerSeverity {
  if (value === 1) return monaco.MarkerSeverity.Error;
  if (value === 2) return monaco.MarkerSeverity.Warning;
  if (value === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

function completionKindFromLsp(monaco: MonacoApi, value: unknown): Monaco.languages.CompletionItemKind {
  const kind = typeof value === "number" ? value : 0;
  const map: Record<number, Monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter
  };

  return map[kind] ?? monaco.languages.CompletionItemKind.Text;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const semanticTokenTypes = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator"
];

const semanticTokenModifiers = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary"
];
