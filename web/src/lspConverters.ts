import type * as Monaco from "monaco-editor";

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

export const maxLspListItems = 5000;

export const semanticTokenTypes = [
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

export const semanticTokenModifiers = [
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

export function lspDiagnosticToMarker(monaco: MonacoApi, diagnostic: unknown): Monaco.editor.IMarkerData {
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

export function completionItemsFromLsp(
  monaco: MonacoApi,
  model: Model,
  position: Monaco.Position,
  result: unknown
): Monaco.languages.CompletionItem[] {
  const rawItems = Array.isArray(result)
    ? result.slice(0, maxLspListItems)
    : result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).items)
      ? ((result as Record<string, unknown>).items as unknown[]).slice(0, maxLspListItems)
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

export function hoverFromLsp(monaco: MonacoApi, result: unknown): Monaco.languages.Hover | null {
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

export function definitionsFromLsp(monaco: MonacoApi, result: unknown): Monaco.languages.Location[] {
  const items = Array.isArray(result) ? result.slice(0, maxLspListItems) : result ? [result] : [];
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

export function toLspPosition(position: Monaco.Position) {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1
  };
}

export function semanticTokenLegendValues(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter(isString) : fallback;
}

export function semanticTokenDataValues(value: unknown, maxValues: number): Uint32Array {
  if (!Array.isArray(value)) {
    return new Uint32Array();
  }

  const cappedLength = Math.min(value.length, Math.max(0, Math.floor(maxValues)));
  const completeLength = cappedLength - (cappedLength % 5);
  if (completeLength === 0) {
    return new Uint32Array();
  }

  const data = new Uint32Array(completeLength);
  for (let index = 0; index < completeLength; index += 1) {
    const tokenValue = value[index];
    if (!isUint32Value(tokenValue)) {
      return new Uint32Array();
    }
    data[index] = tokenValue;
  }
  return data;
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

function isUint32Value(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
