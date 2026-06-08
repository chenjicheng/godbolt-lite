export function mountAppShell(app: HTMLDivElement): void {
  app.innerHTML = `
    <div class="shell">
      <header class="toolbar">
        <div class="brand">Mini Godbolt</div>
        <div class="controls">
          <div class="args-presets" aria-label="Compiler argument presets">
            <button id="args-windows" type="button">Win</button>
            <button id="args-csapp" type="button">CSAPP</button>
          </div>
          <input id="compiler-args" aria-label="Compiler arguments" spellcheck="false" />
          <button id="compile" type="button">Compile</button>
          <button id="run" type="button">Run</button>
          <label class="auto-run-control">
            <input id="auto-run" type="checkbox" />
            <span>Auto-run</span>
          </label>
        </div>
        <div class="view-controls" aria-label="View controls">
          <button id="toggle-files" type="button" aria-pressed="true">Files</button>
          <button id="toggle-asm" type="button" aria-pressed="true">Asm</button>
          <button id="toggle-console" type="button" aria-pressed="true">Console</button>
        </div>
        <div id="status" class="status">Starting</div>
      </header>
      <div id="workspace" class="workspace">
        <aside class="sidebar">
          <div class="sidebar-actions">
            <button id="new-file" type="button">+ File</button>
          </div>
          <div id="files" class="file-list"></div>
        </aside>
        <div id="sidebar-resizer" class="layout-resizer layout-resizer-vertical" role="separator" aria-label="Resize file list" aria-orientation="vertical" tabindex="0"></div>
        <section class="editor-pane">
          <div id="tabs" class="tabs"></div>
          <div id="editor" class="editor"></div>
        </section>
        <div id="asm-resizer" class="layout-resizer layout-resizer-vertical" role="separator" aria-label="Resize assembly pane" aria-orientation="vertical" tabindex="0"></div>
        <section class="asm-pane">
          <div class="panel-title asm-title">
            <span>Assembly</span>
            <div class="asm-controls" aria-label="Assembly view">
              <button id="asm-csapp" type="button" class="active">CSAPP</button>
              <button id="asm-raw" type="button">Raw</button>
            </div>
          </div>
          <pre id="asm" class="asm-output"></pre>
          <div id="console-resizer" class="layout-resizer layout-resizer-horizontal" role="separator" aria-label="Resize console panel" aria-orientation="horizontal" tabindex="0"></div>
          <div class="panel-title">Console</div>
          <pre id="console" class="console-output"></pre>
        </section>
      </div>
      <footer id="meta" class="meta"></footer>
      <div id="file-menu" class="context-menu" role="menu" hidden>
        <button id="file-menu-rename" type="button" role="menuitem"><span>Rename</span><kbd>F2</kbd></button>
        <button id="file-menu-delete" type="button" role="menuitem" class="danger"><span>Delete</span><kbd>Del</kbd></button>
      </div>
      <div id="modal-backdrop" class="modal-backdrop" hidden>
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-message">
          <div id="modal-title" class="modal-title"></div>
          <div id="modal-message" class="modal-message"></div>
          <input id="modal-input" class="modal-input" spellcheck="false" />
          <div class="modal-actions">
            <button id="modal-cancel" type="button">Cancel</button>
            <button id="modal-confirm" type="button" class="primary">OK</button>
          </div>
        </section>
      </div>
    </div>
  `;
}

export function must<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}
