export type StoredOpenTabsState = {
  openTabs: string[];
  activeFile: string;
};

export function readStoredFontScale(storageKey: string, clamp: (value: number) => number): number | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null || raw.trim() === "") return undefined;
    const stored = Number(raw);
    if (Number.isFinite(stored)) return clamp(stored);
  } catch {
    // Keep the default when persisted preferences cannot be read.
  }
  return undefined;
}

export function readStoredPixels(storageKey: string, min: number): number | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null || raw.trim() === "") return undefined;
    const stored = Number(raw);
    if (Number.isFinite(stored)) return Math.max(min, Math.round(stored));
  } catch {
    // Keep CSS defaults when persisted layout preferences cannot be read.
  }
  return undefined;
}

export function writeStoredPixels(storageKey: string, value: number): void {
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function readStoredBoolean(storageKey: string, fallback = false): boolean {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Keep the caller's default when persisted preferences cannot be read.
  }
  return fallback;
}

export function writeStoredBoolean(storageKey: string, value: boolean): void {
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

export function readStoredOpenTabs(storageKey: string): StoredOpenTabsState | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { openTabs: parsed.filter(isString), activeFile: "" };
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const state = parsed as Partial<StoredOpenTabsState>;
    return {
      openTabs: Array.isArray(state.openTabs) ? state.openTabs.filter(isString) : [],
      activeFile: typeof state.activeFile === "string" ? state.activeFile : ""
    };
  } catch {
    // Ignore malformed or inaccessible storage and use the project default.
  }
  return undefined;
}

export function writeStoredOpenTabs(storageKey: string, state: StoredOpenTabsState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
