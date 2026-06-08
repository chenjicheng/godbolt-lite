export type ModalElements = {
  backdrop: HTMLDivElement;
  title: HTMLDivElement;
  message: HTMLDivElement;
  input: HTMLInputElement;
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
};

export type ModalController = {
  showConfirm: (
    title: string,
    message: string,
    confirmText: string,
    danger?: boolean,
    restoreFocus?: HTMLElement | null
  ) => Promise<boolean>;
  close: (confirmed: boolean) => void;
  contains: (target: Node | null) => boolean;
  focusDefault: () => void;
  focusedElement: () => HTMLElement | null;
  isActive: () => boolean;
  trapFocus: (event: KeyboardEvent) => void;
};

type ConfirmState = {
  resolve: (value: boolean) => void;
  restoreFocus: HTMLElement | null;
};

export function createModalController(
  elements: ModalElements,
  options: { beforeOpen?: () => void } = {}
): ModalController {
  let activeModal: ConfirmState | null = null;

  function showConfirm(
    title: string,
    message: string,
    confirmText: string,
    danger = false,
    restoreFocus = focusedElement()
  ): Promise<boolean> {
    close(false);
    return new Promise((resolve) => {
      activeModal = { resolve, restoreFocus };
      open(title, message, confirmText, danger);
      danger ? elements.cancel.focus() : elements.confirm.focus();
    });
  }

  function open(title: string, message: string, confirmText: string, danger: boolean): void {
    options.beforeOpen?.();
    elements.title.textContent = title;
    elements.message.textContent = message;
    elements.message.hidden = !message;
    elements.input.hidden = true;
    elements.input.value = "";
    elements.confirm.textContent = confirmText;
    elements.confirm.classList.toggle("danger", danger);
    elements.backdrop.hidden = false;
  }

  function close(confirmed: boolean): void {
    if (!activeModal) return;

    const modal = activeModal;
    activeModal = null;
    elements.backdrop.hidden = true;
    elements.input.value = "";
    elements.confirm.classList.remove("danger");
    modal.restoreFocus?.focus();
    modal.resolve(confirmed);
  }

  function contains(target: Node | null): boolean {
    return Boolean(target && elements.backdrop.contains(target));
  }

  function focusedElement(): HTMLElement | null {
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function focusableControls(): HTMLElement[] {
    return [elements.cancel, elements.confirm].filter((el) => !el.hidden);
  }

  function focusDefault(): void {
    if (activeModal) elements.cancel.focus();
  }

  function isActive(): boolean {
    return Boolean(activeModal);
  }

  function trapFocus(event: KeyboardEvent): void {
    const controls = focusableControls();
    if (!controls.length) return;

    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !elements.backdrop.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last || !elements.backdrop.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  elements.cancel.addEventListener("click", () => close(false));
  elements.confirm.addEventListener("click", () => close(true));
  elements.backdrop.addEventListener("click", (event) => {
    if (event.target === elements.backdrop) close(false);
  });
  elements.backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close(false);
    }
  });
  window.addEventListener("focusin", (event) => {
    if (activeModal && !contains(event.target as Node)) {
      focusDefault();
    }
  });

  return {
    showConfirm,
    close,
    contains,
    focusDefault,
    focusedElement,
    isActive,
    trapFocus
  };
}
