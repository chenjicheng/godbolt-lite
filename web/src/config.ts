export const legacyDefaultCompilerArgs = "-Og -masm=intel -fno-asynchronous-unwind-tables";
export const windowsDefaultCompilerArgs =
  "-Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig";
export const linuxDefaultCompilerArgs =
  "-target x86_64-pc-linux-gnu -Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig";
export const malformedLinuxDefaultCompilerArgs =
  "-target -Og -g0 -fno-asynchronous-unwind-tables -fno-stack-protector -fno-ident -fno-addrsig";
export const defaultCompilerArgs = windowsDefaultCompilerArgs;

export const codeFontScaleStorageKey = "mini-godbolt.codeFontScale";
export const legacyEditorFontScaleStorageKey = "mini-godbolt.editorFontScale";
export const legacyAsmFontScaleStorageKey = "mini-godbolt.asmFontScale";
export const legacyGlobalFontScaleStorageKey = "mini-godbolt.fontScale";
export const autoRunStorageKey = "mini-godbolt.autoRun";
export const sidebarWidthStorageKey = "mini-godbolt.layout.sidebarWidth";
export const asmWidthStorageKey = "mini-godbolt.layout.asmWidth";
export const consoleHeightStorageKey = "mini-godbolt.layout.consoleHeight";
export const legacyDiagnosticsHeightStorageKey = "mini-godbolt.layout.diagnosticsHeight";
export const legacyOutputHeightStorageKey = "mini-godbolt.layout.outputHeight";
export const filesVisibleStorageKey = "mini-godbolt.view.filesVisible";
export const asmVisibleStorageKey = "mini-godbolt.view.asmVisible";
export const consoleVisibleStorageKey = "mini-godbolt.view.consoleVisible";
export const openTabsStorageKey = "mini-godbolt.openTabsState";
export const draftProjectStorageKey = "mini-godbolt.projectDraft";
export const maxPersistedDraftAgeMs = 30 * 60 * 1000;

export const minFontScale = 0.85;
export const maxFontScale = 1.55;
export const fontScaleStep = 0.08;
export const baseEditorFontSize = 16;
export const baseEditorLineHeight = 24;
export const baseAsmFontSize = 15;
export const baseAsmLineHeight = 24;
export const minSidebarWidth = 150;
export const minEditorWidth = 320;
export const minAsmWidth = 320;
export const minAssemblyTextHeight = 120;
export const minBottomPanelHeight = 70;
export const layoutResizerWidth = 1;
export const rightPaneChromeHeight = 69;
