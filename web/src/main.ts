import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import "@vscode-elements/elements/dist/vscode-icon/index.js";
import "@vscode-elements/elements/dist/vscode-tree/index.js";
import "@vscode-elements/elements/dist/vscode-tree-item/index.js";
import codiconStylesHref from "@vscode/codicons/dist/codicon.css?url";
import type { VscodeIcon } from "@vscode-elements/elements/dist/vscode-icon";
import type { VscodeTree } from "@vscode-elements/elements/dist/vscode-tree";
import type { VscodeTreeItem } from "@vscode-elements/elements/dist/vscode-tree-item";
import "./styles.css";
import { compile, fetchProject, fetchStatus, readSource, runProgram as runProgramApi, syncProject } from "./api";
import { highlightAssembly, simplifyAssembly } from "./assembly";
import { mountAppShell, must } from "./appShell";
import {
  autoRunStorageKey,
  defaultCompilerArgs,
  draftProjectStorageKey,
  legacyDefaultCompilerArgs,
  linuxDefaultCompilerArgs,
  malformedLinuxDefaultCompilerArgs,
  maxPersistedDraftAgeMs,
  openTabsStorageKey,
  windowsDefaultCompilerArgs
} from "./config";
import {
  createLayoutController,
  editorFontSizeForScale,
  editorLineHeightForScale,
  readInitialCodeFontScale
} from "./layoutController";
import { attachLspClient, type LspHandle } from "./lspClient";
import { createModalController } from "./modal";
import {
  normalizeProjectPath,
  pathsEqual,
  validateEditableFolderPath,
  validateEditableSourcePath
} from "./projectPaths";
import { cloneProject, isProjectStateLike, projectFingerprint } from "./projectState";
import { formatRunOutput } from "./runOutput";
import {
  buildFileTree,
  childPathInFolder,
  fileDisplayName,
  folderAncestorPaths,
  parentFolderPath,
  pathInsideFolder,
  type FileTreeNode
} from "./fileTree";
import {
  clearStoredDraft,
  readStoredDraft,
  readStoredBoolean,
  readStoredOpenTabs,
  writeStoredBoolean,
  writeStoredDraft,
  writeStoredOpenTabs
} from "./storage";
import type { CompileResponse, ProjectFile, ProjectState, RunResponse, StatusResponse } from "./types";

self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => {
    if (label === "json") {
      return new JsonWorker();
    }
    return new EditorWorker();
  }
};

function ensureCodiconStylesheet(): void {
  if (document.getElementById("vscode-codicon-stylesheet")) return;
  const link = document.createElement("link");
  link.id = "vscode-codicon-stylesheet";
  link.rel = "stylesheet";
  link.href = codiconStylesHref;
  document.head.append(link);
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing #app");
ensureCodiconStylesheet();
mountAppShell(app);

const statusEl = must("#status");
const metaEl = must("#meta");
const workspaceEl = must<HTMLDivElement>("#workspace");
const sidebarEl = must<HTMLElement>(".sidebar");
const projectRootDropEl = must<HTMLElement>("#project-root-drop");
const filesEl = must<VscodeTree>("#files");
const tabsEl = must("#tabs");
const asmPaneEl = must<HTMLElement>(".asm-pane");
const editorHostEl = must<HTMLDivElement>("#editor");
const asmEl = must("#asm");
const consoleEl = must("#console");
const compilerArgsEl = must<HTMLInputElement>("#compiler-args");
const argsWindowsEl = must<HTMLButtonElement>("#args-windows");
const argsCsappEl = must<HTMLButtonElement>("#args-csapp");
const compileEl = must<HTMLButtonElement>("#compile");
const runEl = must<HTMLButtonElement>("#run");
const autoRunEl = must<HTMLInputElement>("#auto-run");
const toggleFilesEl = must<HTMLButtonElement>("#toggle-files");
const toggleAsmEl = must<HTMLButtonElement>("#toggle-asm");
const toggleConsoleEl = must<HTMLButtonElement>("#toggle-console");
const sidebarResizerEl = must<HTMLDivElement>("#sidebar-resizer");
const asmResizerEl = must<HTMLDivElement>("#asm-resizer");
const consoleResizerEl = must<HTMLDivElement>("#console-resizer");
const asmCsappEl = must<HTMLButtonElement>("#asm-csapp");
const asmRawEl = must<HTMLButtonElement>("#asm-raw");
const fileMenuEl = must<HTMLDivElement>("#file-menu");
const fileMenuNewFileEl = must<HTMLButtonElement>("#file-menu-new-file");
const fileMenuNewFolderEl = must<HTMLButtonElement>("#file-menu-new-folder");
const fileMenuRenameEl = must<HTMLButtonElement>("#file-menu-rename");
const fileMenuDeleteEl = must<HTMLButtonElement>("#file-menu-delete");
const modal = createModalController(
  {
    backdrop: must<HTMLDivElement>("#modal-backdrop"),
    title: must<HTMLDivElement>("#modal-title"),
    message: must<HTMLDivElement>("#modal-message"),
    input: must<HTMLInputElement>("#modal-input"),
    cancel: must<HTMLButtonElement>("#modal-cancel"),
    confirm: must<HTMLButtonElement>("#modal-confirm")
  },
  { beforeOpen: hideFileMenu }
);

const initialCodeFontScale = readInitialCodeFontScale();
autoRunEl.checked = readStoredBoolean(autoRunStorageKey);
tabsEl.setAttribute("role", "tablist");
tabsEl.setAttribute("aria-label", "Open files");

const editor = monaco.editor.create(editorHostEl, {
  automaticLayout: true,
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
  fontSize: editorFontSizeForScale(initialCodeFontScale),
  fontLigatures: false,
  lineHeight: editorLineHeightForScale(initialCodeFontScale),
  minimap: { enabled: false },
  mouseWheelZoom: false,
  quickSuggestions: { comments: false, other: true, strings: true },
  scrollbar: {
    horizontalScrollbarSize: 8,
    verticalScrollbarSize: 8,
    useShadows: false
  },
  scrollBeyondLastLine: false,
  suggestOnTriggerCharacters: true,
  theme: "vs-dark",
  language: "c"
});

let project: ProjectState = { activeFile: "main.c", files: [], compilerArgs: defaultCompilerArgs };
let activeModel: monaco.editor.ITextModel | null = null;
let openTabs: string[] = [];
const models = new Map<string, monaco.editor.ITextModel>();
const readOnlyFiles = new Map<string, ProjectFile>();
const readOnlyByUri = new Map<string, string>();
let compileTimer: number | undefined;
let syncTimer: number | undefined;
let syncVersion = 0;
let syncQueue: Promise<void> = Promise.resolve();
let lastSyncedProjectHash = "";
let toolRunRevision = 0;
let latestCompileId = "";
let latestRunId = "";
let lsp: LspHandle | undefined;
let projectRootUri = "";
type ExplorerTargetKind = "root" | "folder" | "file";
type ExplorerTarget = { kind: ExplorerTargetKind; path: string };
const rootExplorerTarget: ExplorerTarget = { kind: "root", path: "" };
let contextMenuTarget: ExplorerTarget = rootExplorerTarget;
let contextMenuInvoker: HTMLElement | null = null;
let inlineRenameTarget: ExplorerTarget | null = null;
let pendingExplorerFocus: ExplorerTarget | null = null;
let folderStateInitialized = false;
let draggingFilePath = "";
let latestAsm = "";
let latestDiagnostics = "";
let latestRunOutput = "";
let asmView: "csapp" | "raw" = "csapp";
const openFolderPaths = new Set<string>();
const layoutController = createLayoutController({
  editor,
  elements: {
    workspace: workspaceEl,
    sidebar: sidebarEl,
    asmPane: asmPaneEl,
    editorHost: editorHostEl,
    console: consoleEl,
    toggleFiles: toggleFilesEl,
    toggleAsm: toggleAsmEl,
    toggleConsole: toggleConsoleEl,
    sidebarResizer: sidebarResizerEl,
    asmResizer: asmResizerEl,
    consoleResizer: consoleResizerEl
  },
  initialCodeFontScale,
  beforeResize: hideFileMenu
});
layoutController.attach();
updateArgsPresetButtons();
renderAssembly();
void boot();

async function boot(): Promise<void> {
  try {
    const [status, loaded] = await Promise.all([fetchStatus(), fetchProject()]);
    lastSyncedProjectHash = projectFingerprint(loaded);
    const restoredDraft = draftProjectFromStorage(loaded);
    project = restoredDraft ?? loaded;
    project.compilerArgs =
      !project.compilerArgs ||
      project.compilerArgs === legacyDefaultCompilerArgs ||
      project.compilerArgs === linuxDefaultCompilerArgs ||
      project.compilerArgs === malformedLinuxDefaultCompilerArgs ||
      project.compilerArgs === windowsDefaultCompilerArgs
        ? defaultCompilerArgs
        : project.compilerArgs;
    compilerArgsEl.value = project.compilerArgs;
    updateArgsPresetButtons();
    projectRootUri = pathToFileUri(status.projectDir);
    renderMeta(status);
    renderFiles();
    restoreOpenTabs(project.activeFile || project.files[0]?.path || "main.c");
    if (restoredDraft) scheduleSync();
    if (status.ready) {
      lsp = attachLspClient({
        monaco,
        editor,
        languageId: "c",
        rootUri: projectRootUri,
        getModels: () => [...models.values()],
        onStatus: (message) => {
          if (statusEl.textContent !== "Compiling" && statusEl.textContent !== "Running") statusEl.textContent = message;
        }
      });
      statusEl.textContent = "Ready";
    } else {
      statusEl.textContent = "Toolchain missing";
      setDiagnostics(status.toolchain);
    }
  } catch (err) {
    statusEl.textContent = "Startup failed";
    setDiagnostics(String(err));
  }
}

compileEl.addEventListener("click", () => {
  void runCompile();
});

runEl.addEventListener("click", () => {
  cancelPendingCompile();
  invalidateToolRuns();
  void executeProgram();
});

autoRunEl.addEventListener("change", () => {
  writeStoredBoolean(autoRunStorageKey, autoRunEl.checked);
  if (autoRunEl.checked) void runCompile();
});

argsWindowsEl.addEventListener("click", () => {
  setCompilerArgs(windowsDefaultCompilerArgs);
});

argsCsappEl.addEventListener("click", () => {
  setCompilerArgs(linuxDefaultCompilerArgs);
});

asmCsappEl.addEventListener("click", () => {
  asmView = "csapp";
  renderAssembly();
});

asmRawEl.addEventListener("click", () => {
  asmView = "raw";
  renderAssembly();
});

compilerArgsEl.addEventListener("input", () => {
  project.compilerArgs = compilerArgsEl.value;
  updateArgsPresetButtons();
  scheduleSync();
  scheduleCompile();
});

must("#new-file").addEventListener("click", () => createFile(rootExplorerTarget));
must("#new-folder").addEventListener("click", () => createFolder(rootExplorerTarget));
must("#collapse-folders").addEventListener("click", () => {
  openFolderPaths.clear();
  renderFiles(false);
});

fileMenuNewFileEl.addEventListener("click", () => {
  const target = contextMenuTarget;
  hideFileMenu();
  createFile(target);
});

fileMenuNewFolderEl.addEventListener("click", () => {
  const target = contextMenuTarget;
  hideFileMenu();
  createFolder(target);
});

fileMenuRenameEl.addEventListener("click", () => {
  const target = contextMenuTarget;
  hideFileMenu();
  if (target.kind !== "root") beginInlineRename(target);
});

fileMenuDeleteEl.addEventListener("click", () => {
  const target = contextMenuTarget;
  const restoreFocus = contextMenuInvoker;
  hideFileMenu();
  if (target.kind !== "root") void deleteExplorerTarget(target, restoreFocus);
});

window.addEventListener("click", (event) => {
  if (!fileMenuEl.hidden && !fileMenuEl.contains(event.target as Node)) hideFileMenu();
});

window.addEventListener("contextmenu", (event) => {
  if (
    !fileMenuEl.hidden &&
    !fileMenuEl.contains(event.target as Node) &&
    !(event.target as Element).closest?.("vscode-tree-item")
  ) {
    hideFileMenu();
  }
});

window.addEventListener("keydown", (event) => {
  if (modal.isActive() && !modal.contains(event.target as Node)) {
    event.preventDefault();
    modal.focusDefault();
    return;
  }
  if (event.key === "Escape") {
    if (inlineRenameTarget) {
      event.preventDefault();
      cancelInlineRename(true);
      return;
    }
    hideFileMenu(true);
    return;
  }
  const target = shortcutTarget(event.target);
  if (!target) return;
  if (event.key === "F2") {
    event.preventDefault();
    beginInlineRename(target);
  }
  if (event.key === "Delete") {
    event.preventDefault();
    void deleteExplorerTarget(target);
  }
});

filesEl.addEventListener("scroll", () => hideFileMenu());
filesEl.addEventListener("vsc-tree-select", () => {
  captureOpenFolders();
});
filesEl.addEventListener("click", () => window.requestAnimationFrame(captureOpenFolders));
filesEl.addEventListener("keydown", () => window.requestAnimationFrame(captureOpenFolders));
filesEl.addEventListener("contextmenu", (event) => {
  const item = (event.target as Element).closest?.("vscode-tree-item") as VscodeTreeItem | null;
  if (item) return;
  event.preventDefault();
  showFileMenu(rootExplorerTarget, event.clientX, event.clientY, filesEl);
});
filesEl.addEventListener("dragover", (event) => {
  if (!draggingFilePath) return;
  const item = (event.target as Element).closest?.("vscode-tree-item") as VscodeTreeItem | null;
  if (item) return;
  event.preventDefault();
  filesEl.classList.add("drop-target-root");
});
filesEl.addEventListener("dragleave", () => filesEl.classList.remove("drop-target-root"));
filesEl.addEventListener("drop", (event) => {
  if (!draggingFilePath) return;
  const item = (event.target as Element).closest?.("vscode-tree-item") as VscodeTreeItem | null;
  event.preventDefault();
  filesEl.classList.remove("drop-target-root");
  if (item) return;
  void moveFileToFolder(draggingFilePath, "");
});
attachRootDropHandlers(projectRootDropEl);

function openFile(pathInput: string): void {
  const canonicalPath = canonicalSourcePath(pathInput);
  if (!canonicalPath) return;
  const path = canonicalPath;
  const file = project.files.find((item) => item.path === path) ?? readOnlyFiles.get(path);
  if (!file) return;
  const readOnly = readOnlyFiles.has(path);
  ensureOpenTab(path);
  if (!readOnly) project.activeFile = path;
  addOpenAncestors(path);

  let model = models.get(path);
  if (!model) {
    model = monaco.editor.createModel(file.content, "c", modelUriForPath(path));
    model.onDidChangeContent(() => {
      if (readOnlyFiles.has(path)) return;
      const current = project.files.find((item) => item.path === path);
      if (current) current.content = model?.getValue() ?? "";
      scheduleSync();
      if (path.endsWith(".c")) scheduleCompile();
    });
    models.set(path, model);
  }

  activeModel = model;
  editor.setModel(model);
  editor.updateOptions({ readOnly, readOnlyMessage: { value: "System include sources are read-only." } });
  renderFiles(false);
  renderTabs();
  persistOpenTabs();
  if (!readOnly && path.endsWith(".c")) scheduleCompile();
}

function ensureOpenTab(path: string): void {
  pruneOpenTabs();
  const canonicalPath = canonicalSourcePath(path);
  if (canonicalPath && !openTabs.some((item) => pathsEqual(item, canonicalPath))) openTabs.push(canonicalPath);
}

function closeTab(pathInput: string): void {
  pruneOpenTabs();
  const path = canonicalSourcePath(pathInput) ?? pathInput;
  const index = openTabs.findIndex((item) => pathsEqual(item, path));
  if (index < 0) return;

  const model = models.get(path);
  const wasActive = Boolean(model && activeModel === model);
  openTabs.splice(index, 1);

  if (wasActive) {
    editor.setModel(null);
    activeModel = null;
  }
  if (model) {
    model.dispose();
    models.delete(path);
  }
  releaseReadOnlyFile(path);

  if (wasActive) {
    const nextPath = openTabs[index] ?? openTabs[index - 1];
    if (nextPath) {
      openFile(nextPath);
      return;
    }
    editor.updateOptions({ readOnly: true, readOnlyMessage: { value: "Open a file from the explorer." } });
  }

  renderFiles();
  renderTabs();
  persistOpenTabs();
}

function pruneOpenTabs(): void {
  const canonicalTabs: string[] = [];
  for (const path of openTabs) {
    const canonicalPath = canonicalSourcePath(path);
    if (!canonicalPath || canonicalTabs.some((item) => pathsEqual(item, canonicalPath))) continue;
    canonicalTabs.push(canonicalPath);
  }
  openTabs = canonicalTabs;
}

function replaceOpenTabPath(oldPath: string, nextPath: string): void {
  openTabs = openTabs.map((path) => (pathsEqual(path, oldPath) ? nextPath : path));
  persistOpenTabs();
}

function removeOpenTabPath(path: string): void {
  openTabs = openTabs.filter((item) => !pathsEqual(item, path));
  persistOpenTabs();
}

function sourcePathExists(path: string): boolean {
  return canonicalSourcePath(path) !== undefined;
}

function restoreOpenTabs(fallbackPath: string): void {
  const stored = readStoredOpenTabs(openTabsStorageKey);
  if (!stored) {
    openFile(fallbackPath);
    return;
  }

  openTabs = uniqueExistingPaths(stored.openTabs);
  const storedActivePath = canonicalSourcePath(stored.activeFile);
  const activePath = storedActivePath ?? openTabs.find((path) => sourcePathExists(path)) ?? "";

  if (!activePath) {
    if (sourcePathExists(fallbackPath)) {
      openFile(fallbackPath);
      return;
    }
    editor.updateOptions({ readOnly: true, readOnlyMessage: { value: "Open a file from the explorer." } });
    renderFiles();
    renderTabs();
    persistOpenTabs();
    return;
  }

  if (!openTabs.some((path) => pathsEqual(path, activePath))) openTabs.push(activePath);
  openFile(activePath);
}

function persistOpenTabs(): void {
  pruneOpenTabs();
  const editableTabs = openTabs.filter((path) => sourcePathExists(path) && !readOnlyFiles.has(path));
  const activePath = canonicalSourcePath(activeEditorPath()) ?? activeEditorPath();
  writeStoredOpenTabs(openTabsStorageKey, {
    openTabs: editableTabs,
    activeFile: readOnlyFiles.has(activePath) ? project.activeFile : activePath
  });
}

function uniqueExistingPaths(paths: string[]): string[] {
  const result: string[] = [];
  for (const path of paths) {
    const canonicalPath = canonicalSourcePath(path);
    if (!canonicalPath) continue;
    if (result.some((item) => pathsEqual(item, canonicalPath))) continue;
    result.push(canonicalPath);
  }
  return result;
}

function canonicalSourcePath(path: string): string | undefined {
  const normalizedPath = normalizeProjectPath(path);
  const projectFile = project.files.find((file) => pathsEqual(file.path, normalizedPath));
  if (projectFile) return projectFile.path;
  for (const readOnlyPath of readOnlyFiles.keys()) {
    if (pathsEqual(readOnlyPath, normalizedPath)) return readOnlyPath;
  }
  return undefined;
}

function releaseReadOnlyFile(path: string): void {
  const canonicalPath = canonicalSourcePath(path);
  if (!canonicalPath || !readOnlyFiles.has(canonicalPath)) return;
  const stillOpen = openTabs.some((item) => pathsEqual(item, canonicalPath));
  const stillModeled = [...models.keys()].some((item) => pathsEqual(item, canonicalPath));
  if (stillOpen || stillModeled) return;

  readOnlyFiles.delete(canonicalPath);
  for (const [uri, itemPath] of readOnlyByUri) {
    if (pathsEqual(itemPath, canonicalPath)) readOnlyByUri.delete(uri);
  }
}

function activeEditorPath(): string {
  if (!activeModel) return "";
  const activeUri = activeModel.uri.toString();
  for (const file of project.files) {
    if (modelUriForPath(file.path).toString() === activeUri) return file.path;
  }
  for (const file of readOnlyFiles.values()) {
    if (modelUriForPath(file.path).toString() === activeUri) return file.path;
  }
  return "";
}

function renderFiles(captureTreeState = true): void {
  if (captureTreeState) captureOpenFolders();
  hideFileMenu();
  initialiseFolderState();
  if (inlineRenameTarget && !explorerTargetExists(inlineRenameTarget)) inlineRenameTarget = null;

  filesEl.innerHTML = "";
  for (const node of buildFileTree(sortedFiles())) {
    filesEl.append(renderExplorerNode(node));
  }

  const focusTarget = pendingExplorerFocus;
  pendingExplorerFocus = null;
  if (focusTarget) {
    window.requestAnimationFrame(() => explorerItemForTarget(focusTarget)?.focus());
  }
}

function renderExplorerNode(node: FileTreeNode): VscodeTreeItem {
  const item = document.createElement("vscode-tree-item");
  const target: ExplorerTarget = { kind: node.kind, path: node.path };
  item.className = `explorer-tree-item ${node.kind}`;
  item.dataset.projectKind = target.kind;
  item.dataset.projectPath = target.path;
  item.title = target.path;

  if (node.kind === "folder") {
    item.branch = true;
    item.open = openFolderPaths.has(node.path);
    item.append(createIcon("folder", "icon-branch"), createIcon("folder-opened", "icon-branch-opened"));
    attachFolderDropHandlers(item, node.path);
  } else {
    item.selected = pathsEqual(node.path, activeEditorPath());
    item.draggable = true;
    item.append(createIcon(iconNameForFile(node.path), "icon-leaf"));
    attachFileDragHandlers(item, node.path);
  }

  appendTreeLabel(item, target, node.name);
  if (node.kind === "folder") {
    for (const child of node.children) item.append(renderExplorerNode(child));
  }

  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showFileMenu(target, event.clientX, event.clientY, item);
  });
  item.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = item.getBoundingClientRect();
    showFileMenu(target, rect.left + 8, rect.bottom + 4, item);
  });
  item.addEventListener("click", (event) => {
    if (target.kind !== "file" || event.target instanceof HTMLInputElement) return;
    event.stopPropagation();
    openFile(target.path);
  });
  return item;
}

function attachFileDragHandlers(item: VscodeTreeItem, path: string): void {
  item.addEventListener("dragstart", (event) => {
    draggingFilePath = path;
    item.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", path);
    event.dataTransfer?.setData("application/x-mini-godbolt-file", path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  item.addEventListener("dragend", () => {
    draggingFilePath = "";
    item.classList.remove("dragging");
    clearDropTargets();
  });
}

function attachFolderDropHandlers(item: VscodeTreeItem, folderPath: string): void {
  item.addEventListener("dragover", (event) => {
    if (!canDropFileIntoFolder(draggingFilePath, folderPath)) return;
    event.preventDefault();
    item.classList.add("drop-target");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  item.addEventListener("dragleave", () => {
    item.classList.remove("drop-target");
  });
  item.addEventListener("drop", (event) => {
    if (!canDropFileIntoFolder(draggingFilePath, folderPath)) return;
    event.preventDefault();
    event.stopPropagation();
    item.classList.remove("drop-target");
    void moveFileToFolder(draggingFilePath, folderPath);
  });
}

function attachRootDropHandlers(element: HTMLElement): void {
  element.addEventListener("dragover", (event) => {
    if (!canDropFileIntoFolder(draggingFilePath, "")) return;
    event.preventDefault();
    element.classList.add("drop-target");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  element.addEventListener("dragleave", () => {
    element.classList.remove("drop-target");
  });
  element.addEventListener("drop", (event) => {
    if (!canDropFileIntoFolder(draggingFilePath, "")) return;
    event.preventDefault();
    element.classList.remove("drop-target");
    void moveFileToFolder(draggingFilePath, "");
  });
}

function appendTreeLabel(item: VscodeTreeItem, target: ExplorerTarget, labelText: string): void {
  if (isInlineRenameTarget(target)) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "file-rename-input";
    input.value = target.path;
    input.title = target.path;
    input.spellcheck = false;
    input.setAttribute("aria-label", `Rename ${target.path}`);

    let closing = false;
    const cancel = () => {
      closing = true;
      cancelInlineRename(true);
    };
    const commit = async () => {
      if (closing) return;
      closing = true;
      const renamed = await renameExplorerTarget(target, input.value);
      if (!renamed) {
        closing = false;
        input.focus();
        input.select();
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        void commit();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    });
    input.addEventListener("blur", () => {
      if (!closing) void commit();
    });

    item.append(input);
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return;
  }

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = labelText;
  item.append(label);
}

function beginInlineRename(target: ExplorerTarget): void {
  if (!explorerTargetExists(target) || target.kind === "root") return;
  hideFileMenu();
  inlineRenameTarget = target;
  addOpenAncestors(target.path);
  renderFiles(false);
}

function cancelInlineRename(restoreFocus = false): void {
  const target = inlineRenameTarget;
  inlineRenameTarget = null;
  renderFiles(false);
  if (restoreFocus && target) explorerItemForTarget(target)?.focus();
}

function isInlineRenameTarget(target: ExplorerTarget): boolean {
  return Boolean(
    inlineRenameTarget &&
      inlineRenameTarget.kind === target.kind &&
      pathsEqual(inlineRenameTarget.path, target.path)
  );
}

function explorerItemForTarget(target: ExplorerTarget): VscodeTreeItem | null {
  for (const item of filesEl.querySelectorAll<VscodeTreeItem>("vscode-tree-item")) {
    if (item.dataset.projectKind === target.kind && pathsEqual(item.dataset.projectPath ?? "", target.path)) return item;
  }
  return null;
}

function showFileMenu(target: ExplorerTarget, x: number, y: number, invoker: HTMLElement): void {
  contextMenuTarget = target;
  contextMenuInvoker = invoker;
  const isRoot = target.kind === "root";
  fileMenuRenameEl.hidden = isRoot;
  fileMenuDeleteEl.hidden = isRoot;
  fileMenuEl.hidden = false;

  const width = fileMenuEl.offsetWidth;
  const height = fileMenuEl.offsetHeight;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  fileMenuEl.style.left = `${Math.max(8, left)}px`;
  fileMenuEl.style.top = `${Math.max(8, top)}px`;
  fileMenuNewFileEl.focus();
}

function hideFileMenu(restoreFocus = false): void {
  if (fileMenuEl.hidden) return;
  const invoker = contextMenuInvoker;
  fileMenuEl.hidden = true;
  contextMenuTarget = rootExplorerTarget;
  contextMenuInvoker = null;
  fileMenuRenameEl.hidden = false;
  fileMenuDeleteEl.hidden = false;
  if (restoreFocus) invoker?.focus();
}

function renderTabs(): void {
  pruneOpenTabs();
  tabsEl.innerHTML = "";
  const activePath = activeEditorPath();
  for (const path of openTabs) {
    const tab = document.createElement("div");
    tab.className = pathsEqual(path, activePath) ? "tab active" : "tab";
    tab.title = path;
    tab.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(path);
      }
    });

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "tab-label";
    selectButton.setAttribute("role", "tab");
    selectButton.setAttribute("aria-selected", String(pathsEqual(path, activePath)));
    selectButton.setAttribute("aria-label", `Open ${path}`);
    selectButton.tabIndex = pathsEqual(path, activePath) ? 0 : -1;
    selectButton.addEventListener("click", () => openFile(path));

    const icon = document.createElement("span");
    icon.className = path.endsWith(".h") ? "tab-icon header" : "tab-icon source";
    icon.textContent = path.endsWith(".h") ? "H" : "C";
    const label = document.createElement("span");
    label.className = "tab-name";
    label.textContent = path;
    selectButton.append(icon, label);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "tab-close";
    closeButton.textContent = "x";
    closeButton.title = `Close ${path}`;
    closeButton.setAttribute("aria-label", `Close ${path}`);
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(path);
    });

    tab.append(selectButton, closeButton);
    tabsEl.append(tab);
  }
}

function sortedFiles(): ProjectFile[] {
  return [...project.files].sort((a, b) => a.path.localeCompare(b.path));
}

function createFile(target: ExplorerTarget = rootExplorerTarget): void {
  const folderPath = targetFolderPath(target);
  const base = childPathInFolder(folderPath, "new-file");
  let index = 0;
  let path = `${base}.c`;
  while (project.files.some((file) => pathsEqual(file.path, path))) {
    index += 1;
    path = `${base}${index}.c`;
  }
  project.files.push({ path, content: "" });
  inlineRenameTarget = { kind: "file", path };
  addOpenAncestors(path);
  openFile(path);
  scheduleSync();
}

function createFolder(target: ExplorerTarget = rootExplorerTarget): void {
  const parentPath = targetFolderPath(target);
  let index = 0;
  let folderPath = childPathInFolder(parentPath, "new-folder");
  while (project.files.some((file) => pathInsideFolder(file.path, folderPath))) {
    index += 1;
    folderPath = childPathInFolder(parentPath, `new-folder${index}`);
  }

  const path = `${folderPath}/main.c`;
  project.files.push({ path, content: "" });
  openFolderPaths.add(folderPath);
  addOpenAncestors(path);
  inlineRenameTarget = { kind: "folder", path: folderPath };
  openFile(path);
  scheduleSync();
}

async function renameExplorerTarget(target: ExplorerTarget, nextPathInput: string): Promise<boolean> {
  if (target.kind === "file") return renameFile(target.path, nextPathInput);
  if (target.kind === "folder") return renameFolder(target.path, nextPathInput);
  return false;
}

async function renameFile(oldPath: string, nextPathInput: string): Promise<boolean> {
  const file = project.files.find((item) => item.path === oldPath);
  if (!file) return false;

  const nextPath = normalizeProjectPath(nextPathInput);
  if (!nextPath || nextPath === oldPath) {
    inlineRenameTarget = null;
    renderFiles(false);
    explorerItemForTarget({ kind: "file", path: oldPath })?.focus();
    return true;
  }
  const validationError = validateEditableSourcePath(nextPath);
  if (validationError) {
    setDiagnostics(validationError);
    return false;
  }
  if (project.files.some((item) => item.path !== oldPath && pathsEqual(item.path, nextPath))) {
    setDiagnostics(`${nextPath} already exists`);
    return false;
  }

  const nextProject = cloneProject(project);
  const nextFile = nextProject.files.find((item) => item.path === oldPath);
  if (!nextFile) return false;
  const oldModel = models.get(oldPath);
  nextFile.content = oldModel?.getValue() ?? file.content;
  nextFile.path = nextPath;
  if (nextProject.activeFile === oldPath) nextProject.activeFile = nextPath;

  try {
    statusEl.textContent = "Saving";
    await persistProjectNow(nextProject);
  } catch (err) {
    statusEl.textContent = "Save failed";
    setDiagnostics(String(err));
    return false;
  }

  inlineRenameTarget = null;
  replaceOpenTabPath(oldPath, nextPath);
  addOpenAncestors(nextPath);
  if (oldModel) {
    if (activeModel === oldModel) editor.setModel(null);
    oldModel.dispose();
    models.delete(oldPath);
  }
  setDiagnostics("");
  renderFiles();
  renderTabs();
  openFile(nextPath);
  pendingExplorerFocus = { kind: "file", path: nextPath };
  renderFiles(false);
  statusEl.textContent = "Saved";
  return true;
}

async function renameFolder(oldPath: string, nextPathInput: string): Promise<boolean> {
  const movingFiles = project.files.filter((file) => pathInsideFolder(file.path, oldPath));
  if (movingFiles.length === 0) return false;

  const nextPath = normalizeProjectPath(nextPathInput).replace(/\/+$/, "");
  if (!nextPath || pathsEqual(nextPath, oldPath)) {
    inlineRenameTarget = null;
    renderFiles(false);
    explorerItemForTarget({ kind: "folder", path: oldPath })?.focus();
    return true;
  }
  const validationError = validateEditableFolderPath(nextPath);
  if (validationError) {
    setDiagnostics(validationError);
    return false;
  }
  const movingKeys = new Set(movingFiles.map((file) => file.path.toLowerCase()));
  if (project.files.some((file) => !movingKeys.has(file.path.toLowerCase()) && pathInsideFolder(file.path, nextPath))) {
    setDiagnostics(`${nextPath} already exists`);
    return false;
  }

  const nextProject = cloneProject(project);
  const renames = new Map<string, string>();
  for (const file of nextProject.files) {
    if (!pathInsideFolder(file.path, oldPath)) continue;
    const oldFilePath = file.path;
    const model = models.get(oldFilePath);
    file.content = model?.getValue() ?? file.content;
    file.path = nextPath + oldFilePath.slice(oldPath.length);
    renames.set(oldFilePath, file.path);
  }
  if (pathInsideFolder(nextProject.activeFile, oldPath)) {
    nextProject.activeFile = nextPath + nextProject.activeFile.slice(oldPath.length);
  }
  const wasActive = pathInsideFolder(activeEditorPath(), oldPath);

  try {
    statusEl.textContent = "Saving";
    await persistProjectNow(nextProject);
  } catch (err) {
    statusEl.textContent = "Save failed";
    setDiagnostics(String(err));
    return false;
  }

  inlineRenameTarget = null;
  for (const [oldFilePath, nextFilePath] of renames) {
    replaceOpenTabPath(oldFilePath, nextFilePath);
    const model = models.get(oldFilePath);
    if (!model) continue;
    if (activeModel === model) editor.setModel(null);
    model.dispose();
    models.delete(oldFilePath);
  }
  openFolderPaths.delete(oldPath);
  openFolderPaths.add(nextPath);
  addOpenAncestors(`${nextPath}/placeholder.c`);
  setDiagnostics("");
  renderTabs();
  if (wasActive) openFile(project.activeFile);
  pendingExplorerFocus = { kind: "folder", path: nextPath };
  renderFiles(false);
  statusEl.textContent = "Saved";
  return true;
}

async function deleteExplorerTarget(target: ExplorerTarget, restoreFocus?: HTMLElement | null): Promise<void> {
  if (target.kind === "file") return deleteFile(target.path, restoreFocus);
  if (target.kind === "folder") return deleteFolder(target.path, restoreFocus);
}

async function deleteFile(path: string, restoreFocus?: HTMLElement | null): Promise<void> {
  if (project.files.length <= 1) {
    setDiagnostics("Keep at least one project file.");
    return;
  }
  const confirmed = await modal.showConfirm("Delete file", `Delete ${path}?`, "Delete", true, restoreFocus ?? modal.focusedElement());
  if (!confirmed) return;

  const index = project.files.findIndex((file) => file.path === path);
  if (index < 0) return;
  const nextProject = cloneProject(project);
  nextProject.files.splice(index, 1);
  if (nextProject.activeFile === path) {
    const next = nextProject.files.find((file) => file.path.endsWith(".c")) ?? nextProject.files[0];
    nextProject.activeFile = next.path;
  }

  const model = models.get(path);
  const wasActive = Boolean(model && activeModel === model) || pathsEqual(path, activeEditorPath());
  try {
    statusEl.textContent = "Saving";
    await persistProjectNow(nextProject);
  } catch (err) {
    statusEl.textContent = "Save failed";
    setDiagnostics(String(err));
    return;
  }

  if (model) {
    if (activeModel === model) editor.setModel(null);
    model.dispose();
    models.delete(path);
  }
  removeOpenTabPath(path);

  if (wasActive) {
    const next = project.files.find((file) => file.path === project.activeFile) ?? project.files[0];
    activeModel = null;
    openFile(next.path);
  }

  setDiagnostics("");
  renderFiles();
  renderTabs();
  statusEl.textContent = "Saved";
  scheduleCompile();
}

async function deleteFolder(path: string, restoreFocus?: HTMLElement | null): Promise<void> {
  const filesToDelete = project.files.filter((file) => pathInsideFolder(file.path, path));
  if (filesToDelete.length === 0) return;
  if (filesToDelete.length >= project.files.length) {
    setDiagnostics("Keep at least one project file.");
    return;
  }

  const confirmed = await modal.showConfirm(
    "Delete folder",
    `Delete ${path} and ${filesToDelete.length} file${filesToDelete.length === 1 ? "" : "s"}?`,
    "Delete",
    true,
    restoreFocus ?? modal.focusedElement()
  );
  if (!confirmed) return;

  const deletedKeys = new Set(filesToDelete.map((file) => file.path.toLowerCase()));
  const nextProject = cloneProject(project);
  nextProject.files = nextProject.files.filter((file) => !deletedKeys.has(file.path.toLowerCase()));
  if (pathInsideFolder(nextProject.activeFile, path)) {
    const next = nextProject.files.find((file) => file.path.endsWith(".c")) ?? nextProject.files[0];
    nextProject.activeFile = next.path;
  }

  const wasActive = pathInsideFolder(activeEditorPath(), path);
  try {
    statusEl.textContent = "Saving";
    await persistProjectNow(nextProject);
  } catch (err) {
    statusEl.textContent = "Save failed";
    setDiagnostics(String(err));
    return;
  }

  for (const file of filesToDelete) {
    const model = models.get(file.path);
    if (model) {
      if (activeModel === model) editor.setModel(null);
      model.dispose();
      models.delete(file.path);
    }
    removeOpenTabPath(file.path);
  }
  openFolderPaths.delete(path);

  if (wasActive) {
    const next = project.files.find((file) => file.path === project.activeFile) ?? project.files[0];
    activeModel = null;
    openFile(next.path);
  }

  setDiagnostics("");
  renderFiles();
  renderTabs();
  statusEl.textContent = "Saved";
  scheduleCompile();
}

function targetFolderPath(target: ExplorerTarget): string {
  if (target.kind === "folder") return target.path;
  if (target.kind === "file") return parentFolderPath(target.path);
  return "";
}

function treeItemTarget(item: VscodeTreeItem): ExplorerTarget | undefined {
  const kind = item.dataset.projectKind;
  const path = item.dataset.projectPath ?? "";
  if (kind !== "file" && kind !== "folder") return undefined;
  return { kind, path };
}

function captureOpenFolders(): void {
  for (const item of filesEl.querySelectorAll<VscodeTreeItem>('vscode-tree-item[data-project-kind="folder"]')) {
    const path = item.dataset.projectPath;
    if (!path) continue;
    if (item.open) {
      openFolderPaths.add(path);
    } else {
      openFolderPaths.delete(path);
    }
  }
}

function initialiseFolderState(): void {
  if (folderStateInitialized) return;
  for (const path of folderPathsFromNodes(buildFileTree(project.files))) openFolderPaths.add(path);
  folderStateInitialized = true;
}

function folderPathsFromNodes(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    paths.push(node.path);
    paths.push(...folderPathsFromNodes(node.children));
  }
  return paths;
}

function explorerTargetExists(target: ExplorerTarget): boolean {
  if (target.kind === "root") return true;
  if (target.kind === "file") return project.files.some((file) => pathsEqual(file.path, target.path));
  return project.files.some((file) => pathInsideFolder(file.path, target.path));
}

function addOpenAncestors(path: string): void {
  for (const ancestor of folderAncestorPaths(path)) openFolderPaths.add(ancestor);
}

function canDropFileIntoFolder(filePath: string, folderPath: string): boolean {
  if (!filePath || !project.files.some((file) => pathsEqual(file.path, filePath))) return false;
  return !pathsEqual(parentFolderPath(filePath), folderPath);
}

async function moveFileToFolder(filePath: string, folderPath: string): Promise<void> {
  const file = project.files.find((item) => pathsEqual(item.path, filePath));
  if (!file) return;

  const nextPath = childPathInFolder(folderPath, fileDisplayName(file.path));
  if (pathsEqual(file.path, nextPath)) return;
  if (project.files.some((item) => !pathsEqual(item.path, file.path) && pathsEqual(item.path, nextPath))) {
    setDiagnostics(`${nextPath} already exists`);
    return;
  }

  addOpenAncestors(nextPath);
  try {
    await renameFile(file.path, nextPath);
  } finally {
    draggingFilePath = "";
    clearDropTargets();
  }
}

function clearDropTargets(): void {
  for (const item of filesEl.querySelectorAll<VscodeTreeItem>(".drop-target")) {
    item.classList.remove("drop-target");
  }
  filesEl.classList.remove("drop-target-root");
  projectRootDropEl.classList.remove("drop-target");
}

function createIcon(name: string, slot?: string): VscodeIcon {
  const icon = document.createElement("vscode-icon");
  icon.name = name;
  icon.size = 16;
  if (slot) icon.slot = slot;
  return icon;
}

function iconNameForFile(path: string): string {
  if (path.endsWith(".h")) return "symbol-file";
  if (path.endsWith(".inc")) return "file-text";
  return "file-code";
}

function scheduleSync(): void {
  persistProjectDraft();
  window.clearTimeout(syncTimer);
  const version = nextSyncVersion();
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined;
    void queueProjectSync(projectSnapshotForToolRun(), version).catch((err) => {
      if (version === syncVersion) setDiagnostics(String(err));
    });
  }, 250);
}

function scheduleCompile(): void {
  invalidateToolRuns();
  clearTransientOutputs("Compiling...");
  window.clearTimeout(compileTimer);
  compileTimer = window.setTimeout(() => {
    void runCompile(toolRunRevision);
  }, 600);
}

function cancelPendingCompile(): void {
  window.clearTimeout(compileTimer);
  compileTimer = undefined;
}

async function runCompile(revision = toolRunRevision): Promise<void> {
  cancelPendingCompile();
  if (!project.activeFile.endsWith(".c")) {
    clearTransientOutputs("");
    statusEl.textContent = "Open a .c file to compile";
    return;
  }
  const requestId = crypto.randomUUID();
  latestCompileId = requestId;

  const snapshot = projectSnapshotForToolRun();
  try {
    await persistProjectForToolRun(snapshot);
  } catch (err) {
    if (requestId !== latestCompileId || revision !== toolRunRevision) return;
    renderCompile({
      ok: false,
      asm: "",
      stderr: "",
      exitCode: -1,
      durationMs: 0,
      requestId,
      error: `Save failed: ${String(err)}`
    });
    return;
  }
  if (requestId !== latestCompileId || revision !== toolRunRevision) return;

  statusEl.textContent = "Compiling";
  const result = await compile(snapshot.activeFile, snapshot.compilerArgs, requestId).catch((err) => ({
    ok: false,
    asm: "",
    stderr: "",
    exitCode: -1,
    durationMs: 0,
    requestId,
    error: String(err)
  }));
  if (result.requestId !== latestCompileId || revision !== toolRunRevision) return;
  renderCompile(result);
  if (result.ok && autoRunEl.checked) {
    void executeProgram(snapshot, true, revision);
  }
}

async function executeProgram(
  snapshot = projectSnapshotForToolRun(),
  alreadySynced = false,
  revision = toolRunRevision
): Promise<void> {
  if (!snapshot.activeFile.endsWith(".c")) {
    setRunOutput("");
    statusEl.textContent = "Open a .c file to run";
    return;
  }
  const requestId = crypto.randomUUID();
  latestRunId = requestId;

  if (!alreadySynced) {
    try {
      await persistProjectForToolRun(snapshot);
    } catch (err) {
      if (requestId !== latestRunId || revision !== toolRunRevision) return;
      renderRun({
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: -1,
        durationMs: 0,
        requestId,
        error: `Save failed: ${String(err)}`
      });
      return;
    }
  }
  if (requestId !== latestRunId || revision !== toolRunRevision) return;

  statusEl.textContent = "Running";
  setRunOutput("Running...");
  const result = await runProgramApi(snapshot.activeFile, snapshot.compilerArgs, requestId).catch((err) => ({
    ok: false,
    stdout: "",
    stderr: "",
    exitCode: -1,
    durationMs: 0,
    requestId,
    error: String(err)
  }));
  if (result.requestId !== latestRunId || revision !== toolRunRevision) return;
  renderRun(result);
}

function projectSnapshotForToolRun(): ProjectState {
  for (const [path, model] of models) {
    if (readOnlyFiles.has(path)) continue;
    const current = project.files.find((item) => pathsEqual(item.path, path));
    if (current) current.content = model.getValue();
  }
  project.compilerArgs = compilerArgsEl.value.trim() || defaultCompilerArgs;
  return cloneProject(project);
}

function persistProjectDraft(): void {
  writeStoredDraft(draftProjectStorageKey, projectSnapshotForToolRun(), lastSyncedProjectHash);
}

function draftProjectFromStorage(serverProject: ProjectState): ProjectState | undefined {
  const draft = readStoredDraft<ProjectState>(draftProjectStorageKey);
  if (!draft || Date.now() - draft.savedAt > maxPersistedDraftAgeMs) {
    clearStoredDraft(draftProjectStorageKey);
    return undefined;
  }
  if (!isProjectStateLike(draft.project) || draft.baseHash !== projectFingerprint(serverProject)) {
    clearStoredDraft(draftProjectStorageKey);
    return undefined;
  }
  return cloneProject(draft.project);
}

function nextSyncVersion(): number {
  syncVersion += 1;
  return syncVersion;
}

function cancelScheduledSync(): void {
  window.clearTimeout(syncTimer);
  syncTimer = undefined;
}

function persistProjectNow(snapshot: ProjectState): Promise<ProjectState> {
  cancelScheduledSync();
  return queueProjectSync(snapshot, nextSyncVersion());
}

function persistProjectForToolRun(snapshot: ProjectState): Promise<ProjectState> {
  cancelScheduledSync();
  return queueProjectSync(snapshot, nextSyncVersion());
}

function queueProjectSync(snapshot: ProjectState, version: number): Promise<ProjectState> {
  const task = syncQueue
    .catch(() => undefined)
    .then(() => syncProject(snapshot))
    .then((saved) => {
      if (version === syncVersion) {
        project = saved;
        lastSyncedProjectHash = projectFingerprint(saved);
        clearStoredDraft(draftProjectStorageKey);
      }
      return saved;
    });
  syncQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

function invalidateToolRuns(): void {
  toolRunRevision += 1;
  latestCompileId = "";
  latestRunId = "";
}

function renderCompile(result: CompileResponse): void {
  latestAsm = result.asm || "";
  latestRunOutput = "";
  renderAssembly();
  setDiagnostics([result.error, result.stderr].filter(Boolean).join("\n\n"));
  statusEl.textContent = result.ok ? `Compiled in ${result.durationMs}ms` : `Compile failed (${result.exitCode})`;
}

function clearTransientOutputs(asmText: string): void {
  latestAsm = asmText;
  latestDiagnostics = "";
  latestRunOutput = "";
  renderAssembly();
  renderConsole();
}

function renderRun(result: RunResponse): void {
  setRunOutput(formatRunOutput(result));
  statusEl.textContent = result.ok
    ? `Exited with code ${result.exitCode} in ${result.durationMs}ms`
    : `Run failed (${result.exitCode})`;
}

function setCompilerArgs(value: string): void {
  compilerArgsEl.value = value;
  project.compilerArgs = value;
  updateArgsPresetButtons();
  scheduleSync();
  scheduleCompile();
}

function updateArgsPresetButtons(): void {
  const value = compilerArgsEl.value.trim();
  const windowsActive = value === windowsDefaultCompilerArgs;
  const csappActive = value === linuxDefaultCompilerArgs;
  argsWindowsEl.classList.toggle("active", windowsActive);
  argsWindowsEl.setAttribute("aria-pressed", String(windowsActive));
  argsCsappEl.classList.toggle("active", csappActive);
  argsCsappEl.setAttribute("aria-pressed", String(csappActive));
}

function setDiagnostics(text: string): void {
  latestDiagnostics = text;
  renderConsole();
}

function setRunOutput(text: string): void {
  latestRunOutput = text;
  renderConsole();
}

function renderConsole(): void {
  const sections: string[] = [];
  if (latestDiagnostics.trim()) sections.push(`Diagnostics\n${latestDiagnostics}`);
  if (latestRunOutput.trim()) sections.push(`Output\n${latestRunOutput}`);
  consoleEl.textContent = sections.join("\n\n");
}

function renderAssembly(): void {
  const csappActive = asmView === "csapp";
  const rawActive = asmView === "raw";
  asmCsappEl.classList.toggle("active", csappActive);
  asmCsappEl.setAttribute("aria-pressed", String(csappActive));
  asmRawEl.classList.toggle("active", rawActive);
  asmRawEl.setAttribute("aria-pressed", String(rawActive));
  const text = asmView === "csapp" ? simplifyAssembly(latestAsm) : latestAsm;
  asmEl.innerHTML = highlightAssembly(text);
}

function renderMeta(status: StatusResponse): void {
  metaEl.textContent = status.ready ? "Project workspace ready | System headers ready" : "Project workspace ready | Toolchain missing";
}

editor.onMouseDown((event) => {
  if (!event.event.ctrlKey && !event.event.metaKey) return;
  if (!event.target.position || !activeModel || !lsp) return;
  void jumpToDefinition(activeModel, event.target.position);
});

async function jumpToDefinition(model: monaco.editor.ITextModel, position: monaco.Position): Promise<void> {
  try {
    const locations = await lsp?.definition(model, position);
    const target = locations?.[0];
    if (!target) return;

    const targetUri = target.uri.toString();
    let path = pathFromProjectUri(targetUri);
    if (!path) {
      const source = await readSource(targetUri);
      path = source.path;
      if (source.readOnly) {
        readOnlyFiles.set(path, { path, content: source.content });
        readOnlyByUri.set(targetUri, path);
      } else {
        const normalizedPath = normalizeProjectPath(path);
        const validationError = validateEditableSourcePath(normalizedPath);
        if (validationError) {
          setDiagnostics(validationError);
          return;
        }
        const existing = project.files.find((file) => pathsEqual(file.path, normalizedPath));
        if (existing) {
          path = existing.path;
        } else {
          project.files.push({ path: normalizedPath, content: source.content });
          path = normalizedPath;
        }
      }
    }
    openFile(path);
    editor.revealRangeInCenter(target.range);
    editor.setPosition({ lineNumber: target.range.startLineNumber, column: target.range.startColumn });
    editor.focus();
  } catch (err) {
    setDiagnostics(String(err));
  }
}

function modelUriForPath(path: string): monaco.Uri {
  const uri = readOnlyByUri.size > 0 ? [...readOnlyByUri.entries()].find(([, itemPath]) => itemPath === path)?.[0] : undefined;
  if (uri) return monaco.Uri.parse(uri);
  return monaco.Uri.parse(`${projectRootUri}/${path.split("/").map(encodeURIComponent).join("/")}`);
}

function pathFromProjectUri(uri: string): string | undefined {
  const root = projectRootUri.toLowerCase();
  const candidate = uri.toLowerCase();
  if (!root || !candidate.startsWith(root + "/")) return undefined;
  const encoded = uri.slice(projectRootUri.length + 1);
  const path = encoded
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
  return project.files.find((file) => pathsEqual(file.path, path))?.path;
}

function pathToFileUri(path: string): string {
  return monaco.Uri.file(path).toString();
}

function shortcutTarget(target: EventTarget | null): ExplorerTarget | undefined {
  if (!(target instanceof Element)) return undefined;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return undefined;
  }
  if (modal.isActive() && modal.contains(target)) return undefined;
  if (!fileMenuEl.hidden && fileMenuEl.contains(target)) return undefined;

  const treeItem = target.closest("vscode-tree-item") as VscodeTreeItem | null;
  const treeTarget = treeItem ? treeItemTarget(treeItem) : undefined;
  if (treeTarget) return treeTarget;

  const activePath = activeEditorPath() || project.activeFile;
  const activeFile = project.files.find((file) => pathsEqual(file.path, activePath));
  if ((target.closest(".editor") || target === document.body) && activeFile) {
    return { kind: "file", path: activeFile.path };
  }
  return undefined;
}

window.addEventListener("beforeunload", () => {
  persistOpenTabs();
  layoutController.dispose();
  lsp?.dispose();
});
