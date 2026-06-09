import type * as Monaco from "monaco-editor";
import {
  asmVisibleStorageKey,
  asmWidthStorageKey,
  baseAsmFontSize,
  baseAsmLineHeight,
  baseEditorFontSize,
  baseEditorLineHeight,
  codeFontScaleStorageKey,
  consoleHeightStorageKey,
  consoleVisibleStorageKey,
  filesVisibleStorageKey,
  fontScaleStep,
  layoutResizerWidth,
  legacyAsmFontScaleStorageKey,
  legacyDiagnosticsHeightStorageKey,
  legacyEditorFontScaleStorageKey,
  legacyGlobalFontScaleStorageKey,
  legacyOutputHeightStorageKey,
  maxFontScale,
  minAsmWidth,
  minAssemblyTextHeight,
  minBottomPanelHeight,
  minEditorWidth,
  minFontScale,
  minSidebarWidth,
  rightPaneChromeHeight,
  sidebarWidthStorageKey
} from "./config";
import {
  readStoredBoolean,
  readStoredFontScale,
  readStoredPixels,
  writeStoredBoolean,
  writeStoredPixels
} from "./storage";

type MonacoEditor = Monaco.editor.IStandaloneCodeEditor;
type LayoutResizeKind = "sidebar" | "asm" | "console";

type LayoutResizeState = {
  kind: LayoutResizeKind;
  handle: HTMLDivElement;
  pointerId: number;
  startX: number;
  startY: number;
  startSize: number;
};

type LayoutControllerElements = {
  workspace: HTMLDivElement;
  sidebar: HTMLElement;
  asmPane: HTMLElement;
  editorHost: HTMLDivElement;
  console: HTMLElement;
  toggleFiles: HTMLButtonElement;
  toggleAsm: HTMLButtonElement;
  toggleConsole: HTMLButtonElement;
  sidebarResizer: HTMLDivElement;
  asmResizer: HTMLDivElement;
  consoleResizer: HTMLDivElement;
};

type LayoutControllerOptions = {
  editor: MonacoEditor;
  elements: LayoutControllerElements;
  initialCodeFontScale: number;
  beforeResize: () => void;
};

export type LayoutController = {
  attach: () => void;
  dispose: () => void;
};

export function readInitialCodeFontScale(): number {
  const current = readStoredFontScale(codeFontScaleStorageKey, clampFontScale);
  if (current !== undefined) return current;

  const legacyScales = [
    readStoredFontScale(legacyEditorFontScaleStorageKey, clampFontScale),
    readStoredFontScale(legacyAsmFontScaleStorageKey, clampFontScale),
    readStoredFontScale(legacyGlobalFontScaleStorageKey, clampFontScale)
  ].filter((value): value is number => value !== undefined);
  if (legacyScales.length > 0) return Math.max(...legacyScales);
  return 1;
}

export function editorFontSizeForScale(scale: number): number {
  return Math.round(baseEditorFontSize * clampFontScale(scale));
}

export function editorLineHeightForScale(scale: number): number {
  return Math.round(baseEditorLineHeight * clampFontScale(scale));
}

export function createLayoutController(options: LayoutControllerOptions): LayoutController {
  const { editor, elements, initialCodeFontScale, beforeResize } = options;
  const {
    workspace,
    sidebar,
    asmPane,
    editorHost,
    console,
    toggleFiles,
    toggleAsm,
    toggleConsole,
    sidebarResizer,
    asmResizer,
    consoleResizer
  } = elements;

  let codeFontScale = clampFontScale(initialCodeFontScale);
  let sidebarWidth = readStoredPixels(sidebarWidthStorageKey, minSidebarWidth);
  let asmWidth = readStoredPixels(asmWidthStorageKey, minAsmWidth);
  let consoleHeight = readInitialConsoleHeight();
  let filesVisible = readStoredBoolean(filesVisibleStorageKey, true);
  let asmVisible = readStoredBoolean(asmVisibleStorageKey, true);
  let consoleVisible = readStoredBoolean(consoleVisibleStorageKey, true);
  let activeLayoutResize: LayoutResizeState | null = null;
  let editorLayoutFrame: number | undefined;
  const disposers: Array<() => void> = [];

  applyViewVisibility();
  applyLayoutSizes();

  function attach(): void {
    listen(toggleFiles, "click", () => {
      filesVisible = !filesVisible;
      writeStoredBoolean(filesVisibleStorageKey, filesVisible);
      applyViewVisibility();
    });
    listen(toggleAsm, "click", () => {
      asmVisible = !asmVisible;
      writeStoredBoolean(asmVisibleStorageKey, asmVisible);
      applyViewVisibility();
    });
    listen(toggleConsole, "click", () => {
      consoleVisible = !consoleVisible;
      writeStoredBoolean(consoleVisibleStorageKey, consoleVisible);
      applyViewVisibility();
    });

    listen(window, "wheel", handleFontZoomWheel, { passive: false });
    listen(sidebarResizer, "pointerdown", (event) => startLayoutResize("sidebar", event));
    listen(asmResizer, "pointerdown", (event) => startLayoutResize("asm", event));
    listen(consoleResizer, "pointerdown", (event) => startLayoutResize("console", event));
    listen(sidebarResizer, "lostpointercapture", finishLayoutResize);
    listen(asmResizer, "lostpointercapture", finishLayoutResize);
    listen(consoleResizer, "lostpointercapture", finishLayoutResize);
    listen(window, "pointermove", handleLayoutResizeMove);
    listen(window, "pointerup", finishLayoutResize);
    listen(window, "pointercancel", finishLayoutResize);
    listen(window, "blur", finishLayoutResize);
    listen(document, "visibilitychange", () => {
      if (document.hidden) finishLayoutResize();
    });
    listen(window, "resize", () => {
      clampLayoutSizesToViewport();
      applyLayoutSizes();
      queueEditorLayout();
    });
    applyFontScales();
  }

  function dispose(): void {
    finishLayoutResize();
    if (editorLayoutFrame !== undefined) {
      window.cancelAnimationFrame(editorLayoutFrame);
      editorLayoutFrame = undefined;
    }
    for (const disposeListener of disposers.splice(0)) {
      disposeListener();
    }
  }

  function listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void;
  function listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void;
  function listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void;
  function listen(
    target: Window | Document | HTMLElement,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, listener, options);
    disposers.push(() => target.removeEventListener(type, listener, options));
  }

  function handleFontZoomWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    if (!isCodeFontZoomTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY < 0 ? 1 : -1;
    setCodeFontScale(codeFontScale + direction * fontScaleStep);
  }

  function applyViewVisibility(): void {
    workspace.classList.toggle("files-hidden", !filesVisible);
    workspace.classList.toggle("asm-hidden", !asmVisible);
    asmPane.classList.toggle("console-hidden", !consoleVisible);

    toggleFiles.classList.toggle("active", filesVisible);
    toggleAsm.classList.toggle("active", asmVisible);
    toggleConsole.classList.toggle("active", consoleVisible);
    toggleFiles.setAttribute("aria-pressed", String(filesVisible));
    toggleAsm.setAttribute("aria-pressed", String(asmVisible));
    toggleConsole.setAttribute("aria-pressed", String(consoleVisible));

    clampLayoutSizesToViewport();
    applyLayoutSizes();
    queueSettledEditorLayout();
  }

  function startLayoutResize(kind: LayoutResizeKind, event: PointerEvent): void {
    if (window.matchMedia("(max-width: 980px)").matches) return;

    const handle = event.currentTarget as HTMLDivElement;
    event.preventDefault();
    beforeResize();
    activeLayoutResize = {
      kind,
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSize: currentLayoutSize(kind)
    };
    handle.classList.add("active");
    document.body.classList.add(
      "resizing-layout",
      kind === "sidebar" || kind === "asm" ? "resizing-layout-col" : "resizing-layout-row"
    );
    handle.setPointerCapture(event.pointerId);
  }

  function handleLayoutResizeMove(event: PointerEvent): void {
    if (!activeLayoutResize) return;

    event.preventDefault();
    const dx = event.clientX - activeLayoutResize.startX;
    const dy = event.clientY - activeLayoutResize.startY;

    switch (activeLayoutResize.kind) {
      case "sidebar":
        sidebarWidth = clampPixels(activeLayoutResize.startSize + dx, minSidebarWidth, maxSidebarWidth());
        break;
      case "asm":
        asmWidth = clampPixels(activeLayoutResize.startSize - dx, minAsmWidth, maxAsmWidth());
        break;
      case "console":
        consoleHeight = clampPixels(activeLayoutResize.startSize - dy, minBottomPanelHeight, maxConsoleHeight());
        break;
    }

    applyLayoutSizes();
    queueEditorLayout();
  }

  function finishLayoutResize(): void {
    const resize = activeLayoutResize;
    if (!resize) return;
    activeLayoutResize = null;

    resize.handle.classList.remove("active");
    try {
      resize.handle.releasePointerCapture(resize.pointerId);
    } catch {
      // The browser can release capture before pointerup when a drag leaves the window.
    }
    persistLayoutSize(resize.kind);
    document.body.classList.remove("resizing-layout", "resizing-layout-col", "resizing-layout-row");
    queueSettledEditorLayout();
  }

  function applyLayoutSizes(): void {
    setOptionalPixelCssVar("--sidebar-width", sidebarWidth);
    setOptionalPixelCssVar("--asm-width", asmWidth);
    setOptionalPixelCssVar("--console-height", consoleHeight);
  }

  function clampLayoutSizesToViewport(): void {
    if (sidebarWidth !== undefined) sidebarWidth = clampPixels(sidebarWidth, minSidebarWidth, maxSidebarWidth());
    if (asmWidth !== undefined) asmWidth = clampPixels(asmWidth, minAsmWidth, maxAsmWidth());
    if (consoleHeight !== undefined) consoleHeight = clampPixels(consoleHeight, minBottomPanelHeight, maxConsoleHeight());
  }

  function persistLayoutSize(kind: LayoutResizeKind): void {
    switch (kind) {
      case "sidebar":
        if (sidebarWidth !== undefined) writeStoredPixels(sidebarWidthStorageKey, sidebarWidth);
        break;
      case "asm":
        if (asmWidth !== undefined) writeStoredPixels(asmWidthStorageKey, asmWidth);
        break;
      case "console":
        if (consoleHeight !== undefined) writeStoredPixels(consoleHeightStorageKey, consoleHeight);
        break;
    }
  }

  function currentLayoutSize(kind: LayoutResizeKind): number {
    switch (kind) {
      case "sidebar":
        return measuredWidth(sidebar, 220);
      case "asm":
        return measuredWidth(asmPane, Math.round(window.innerWidth * 0.46));
      case "console":
        return measuredHeight(console, Math.round(window.innerHeight * 0.24));
    }
  }

  function maxSidebarWidth(): number {
    const workspaceWidth = workspace.clientWidth || window.innerWidth;
    const reservedAsmWidth = asmVisible ? currentAsmWidth() : 0;
    const visibleResizerWidth = layoutResizerWidth + (asmVisible ? layoutResizerWidth : 0);
    return Math.max(minSidebarWidth, workspaceWidth - reservedAsmWidth - minEditorWidth - visibleResizerWidth);
  }

  function maxAsmWidth(): number {
    const workspaceWidth = workspace.clientWidth || window.innerWidth;
    const reservedSidebarWidth = filesVisible ? currentSidebarWidth() : 0;
    const visibleResizerWidth = layoutResizerWidth + (filesVisible ? layoutResizerWidth : 0);
    return Math.max(minAsmWidth, workspaceWidth - reservedSidebarWidth - minEditorWidth - visibleResizerWidth);
  }

  function maxConsoleHeight(): number {
    const paneHeight = asmPane.clientHeight || window.innerHeight;
    return Math.max(minBottomPanelHeight, paneHeight - rightPaneChromeHeight - minAssemblyTextHeight);
  }

  function currentSidebarWidth(): number {
    return sidebarWidth ?? measuredWidth(sidebar, 220);
  }

  function currentAsmWidth(): number {
    return asmWidth ?? measuredWidth(asmPane, Math.round(window.innerWidth * 0.46));
  }

  function queueEditorLayout(): void {
    if (editorLayoutFrame !== undefined) return;
    editorLayoutFrame = window.requestAnimationFrame(() => {
      editorLayoutFrame = undefined;
      layoutEditorToHost();
    });
  }

  function queueSettledEditorLayout(): void {
    queueEditorLayout();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(layoutEditorToHost);
    });
  }

  function layoutEditorToHost(): void {
    const rect = editorHost.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width > 0 && height > 0) {
      editor.layout({ width, height });
      return;
    }
    editor.layout();
  }

  function isCodeFontZoomTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(".editor") || target.closest(".asm-output"));
  }

  function setCodeFontScale(nextScale: number): void {
    codeFontScale = clampFontScale(nextScale);
    try {
      localStorage.setItem(codeFontScaleStorageKey, String(codeFontScale));
      localStorage.setItem(legacyEditorFontScaleStorageKey, String(codeFontScale));
      localStorage.setItem(legacyAsmFontScaleStorageKey, String(codeFontScale));
    } catch {
      // localStorage can be unavailable in restricted browser contexts.
    }
    applyFontScales();
  }

  function applyFontScales(): void {
    document.documentElement.style.setProperty("--asm-font-size", `${Math.round(baseAsmFontSize * codeFontScale)}px`);
    document.documentElement.style.setProperty("--asm-line-height", `${Math.round(baseAsmLineHeight * codeFontScale)}px`);
    editor.updateOptions({
      fontSize: editorFontSizeForScale(codeFontScale),
      lineHeight: editorLineHeightForScale(codeFontScale)
    });
    queueEditorLayout();
  }

  return { attach, dispose };
}

function readInitialConsoleHeight(): number | undefined {
  const current = readStoredPixels(consoleHeightStorageKey, minBottomPanelHeight);
  if (current !== undefined) return current;

  const legacyHeights = [
    readStoredPixels(legacyDiagnosticsHeightStorageKey, minBottomPanelHeight),
    readStoredPixels(legacyOutputHeightStorageKey, minBottomPanelHeight)
  ].filter((value): value is number => value !== undefined);
  if (legacyHeights.length > 0) return Math.max(...legacyHeights);
  return undefined;
}

function measuredWidth(element: Element, fallback: number): number {
  const width = element.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? width : fallback;
}

function measuredHeight(element: Element, fallback: number): number {
  const height = element.getBoundingClientRect().height;
  return Number.isFinite(height) && height > 0 ? height : fallback;
}

function setOptionalPixelCssVar(name: string, value: number | undefined): void {
  if (value === undefined) {
    document.documentElement.style.removeProperty(name);
    return;
  }
  document.documentElement.style.setProperty(name, `${value}px`);
}

function clampFontScale(value: number): number {
  return Math.min(maxFontScale, Math.max(minFontScale, value));
}

function clampPixels(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(min, max), Math.max(min, value)));
}
