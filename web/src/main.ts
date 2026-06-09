import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
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
import { normalizeProjectPath, pathsEqual, validateEditableSourcePath } from "./projectPaths";
import { cloneProject, isProjectStateLike, projectFingerprint } from "./projectState";
import { formatRunOutput } from "./runOutput";
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

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing #app");
mountAppShell(app);

const statusEl = must("#status");
const metaEl = must("#meta");
const workspaceEl = must<HTMLDivElement>("#workspace");
const sidebarEl = must<HTMLElement>(".sidebar");
const filesEl = must("#files");
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
let contextMenuPath = "";
let contextMenuInvoker: HTMLElement | null = null;
let inlineRenamePath = "";
let latestAsm = "";
let latestDiagnostics = "";
let latestRunOutput = "";
let asmView: "csapp" | "raw" = "csapp";
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

must("#new-file").addEventListener("click", () => createFile());

fileMenuRenameEl.addEventListener("click", () => {
  const path = contextMenuPath;
  hideFileMenu();
  if (path) beginInlineRename(path);
});

fileMenuDeleteEl.addEventListener("click", () => {
  const path = contextMenuPath;
  const restoreFocus = contextMenuInvoker;
  hideFileMenu();
  if (path) void deleteFile(path, restoreFocus);
});

window.addEventListener("click", (event) => {
  if (!fileMenuEl.hidden && !fileMenuEl.contains(event.target as Node)) hideFileMenu();
});

window.addEventListener("contextmenu", (event) => {
  if (!fileMenuEl.hidden && !fileMenuEl.contains(event.target as Node) && !(event.target as Element).closest?.(".file-row")) {
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
    if (inlineRenamePath) {
      event.preventDefault();
      cancelInlineRename(true);
      return;
    }
    hideFileMenu(true);
    return;
  }
  const path = shortcutTargetPath(event.target);
  if (!path) return;
  if (event.key === "F2") {
    event.preventDefault();
    beginInlineRename(path);
  }
  if (event.key === "Delete") {
    event.preventDefault();
    void deleteFile(path);
  }
});

filesEl.addEventListener("scroll", () => hideFileMenu());

function openFile(pathInput: string): void {
  const canonicalPath = canonicalSourcePath(pathInput);
  if (!canonicalPath) return;
  const path = canonicalPath;
  const file = project.files.find((item) => item.path === path) ?? readOnlyFiles.get(path);
  if (!file) return;
  const readOnly = readOnlyFiles.has(path);
  ensureOpenTab(path);
  if (!readOnly) project.activeFile = path;

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
  editor.updateOptions({ readOnly, readOnlyMessage: { value: "Third-party include sources are read-only." } });
  renderFiles();
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

function renderFiles(): void {
  hideFileMenu();
  if (inlineRenamePath && !project.files.some((file) => file.path === inlineRenamePath)) {
    inlineRenamePath = "";
  }
  filesEl.innerHTML = "";
  const activePath = activeEditorPath();
  for (const file of sortedFiles()) {
    const row = document.createElement("div");
    row.className = pathsEqual(file.path, activePath) ? "file-row active" : "file-row";

    if (file.path === inlineRenamePath) {
      row.classList.add("renaming");
      const renameInput = document.createElement("input");
      renameInput.type = "text";
      renameInput.className = "file-rename-input";
      renameInput.value = file.path;
      renameInput.title = file.path;
      renameInput.dataset.path = file.path;
      renameInput.spellcheck = false;
      renameInput.setAttribute("aria-label", `Rename ${file.path}`);

      let closing = false;
      const cancel = () => {
        closing = true;
        cancelInlineRename(true);
      };
      const commit = async () => {
        if (closing) return;
        closing = true;
        const renamed = await renameFile(file.path, renameInput.value);
        if (!renamed) {
          closing = false;
          renameInput.focus();
          renameInput.select();
        }
      };

      renameInput.addEventListener("keydown", (event) => {
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
      renameInput.addEventListener("blur", () => {
        if (!closing) void commit();
      });

      row.append(renameInput);
      filesEl.append(row);
      window.requestAnimationFrame(() => {
        renameInput.focus();
        renameInput.select();
      });
      continue;
    }

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "file";
    openButton.title = file.path;
    openButton.dataset.path = file.path;
    openButton.setAttribute("aria-haspopup", "menu");

    const icon = document.createElement("span");
    icon.className = file.path.endsWith(".h") ? "file-icon header" : "file-icon source";
    icon.textContent = file.path.endsWith(".h") ? "H" : "C";
    const label = document.createElement("span");
    label.className = "file-name";
    label.textContent = file.path;
    openButton.append(icon, label);

    openButton.addEventListener("click", () => openFile(file.path));
    openButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openFile(file.path);
      showFileMenu(file.path, event.clientX, event.clientY, fileButtonForPath(file.path) ?? openButton);
    });
    openButton.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      openFile(file.path);
      const invoker = fileButtonForPath(file.path) ?? openButton;
      const rect = invoker.getBoundingClientRect();
      showFileMenu(file.path, rect.left + 8, rect.bottom + 4, invoker);
    });

    row.append(openButton);
    filesEl.append(row);
  }
}

function beginInlineRename(path: string): void {
  if (!project.files.some((file) => file.path === path)) return;
  hideFileMenu();
  inlineRenamePath = path;
  renderFiles();
}

function cancelInlineRename(restoreFocus = false): void {
  const path = inlineRenamePath;
  inlineRenamePath = "";
  renderFiles();
  if (restoreFocus && path) fileButtonForPath(path)?.focus();
}

function fileButtonForPath(path: string): HTMLButtonElement | null {
  for (const button of filesEl.querySelectorAll<HTMLButtonElement>(".file")) {
    if (button.dataset.path === path) return button;
  }
  return null;
}

function showFileMenu(path: string, x: number, y: number, invoker: HTMLElement): void {
  contextMenuPath = path;
  contextMenuInvoker = invoker;
  fileMenuEl.hidden = false;

  const width = fileMenuEl.offsetWidth;
  const height = fileMenuEl.offsetHeight;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  fileMenuEl.style.left = `${Math.max(8, left)}px`;
  fileMenuEl.style.top = `${Math.max(8, top)}px`;
  fileMenuRenameEl.focus();
}

function hideFileMenu(restoreFocus = false): void {
  if (fileMenuEl.hidden) return;
  const invoker = contextMenuInvoker;
  fileMenuEl.hidden = true;
  contextMenuPath = "";
  contextMenuInvoker = null;
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

function createFile(): void {
  const base = "new-file";
  let index = 0;
  let path = `${base}.c`;
  while (project.files.some((file) => pathsEqual(file.path, path))) {
    index += 1;
    path = `${base}${index}.c`;
  }
  project.files.push({ path, content: "" });
  inlineRenamePath = path;
  openFile(path);
  scheduleSync();
}

async function renameFile(oldPath: string, nextPathInput: string): Promise<boolean> {
  const file = project.files.find((item) => item.path === oldPath);
  if (!file) return false;

  const nextPath = normalizeProjectPath(nextPathInput);
  if (!nextPath || nextPath === oldPath) {
    inlineRenamePath = "";
    renderFiles();
    fileButtonForPath(oldPath)?.focus();
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

  inlineRenamePath = "";
  replaceOpenTabPath(oldPath, nextPath);
  if (oldModel) {
    if (activeModel === oldModel) editor.setModel(null);
    oldModel.dispose();
    models.delete(oldPath);
  }
  setDiagnostics("");
  renderFiles();
  renderTabs();
  openFile(nextPath);
  fileButtonForPath(nextPath)?.focus();
  statusEl.textContent = "Saved";
  return true;
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
  metaEl.textContent = `Project: ${status.projectDir} | Include: ${status.includeDir} | System: ${status.systemIncludeDir}`;
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

function shortcutTargetPath(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "";
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return "";
  }
  if (modal.isActive() && modal.contains(target)) return "";
  if (!fileMenuEl.hidden && fileMenuEl.contains(target)) return "";

  const fileButton = target.closest<HTMLButtonElement>(".file");
  if (fileButton?.dataset.path) return fileButton.dataset.path;
  if (target.closest(".editor")) return activeEditorPath() || project.activeFile;
  if (target === document.body) return activeEditorPath() || project.activeFile;
  return "";
}

window.addEventListener("beforeunload", () => {
  persistOpenTabs();
  layoutController.dispose();
  lsp?.dispose();
});
