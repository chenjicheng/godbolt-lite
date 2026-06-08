const reservedWindowsNames = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

export function normalizeProjectPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
}

export function validateEditableSourcePath(path: string): string | undefined {
  if (!path) return "File name is required.";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "Absolute paths are not allowed.";
  if (path === "external" || path.startsWith("external/")) return "The external/ namespace is reserved for read-only includes.";
  if (!path.endsWith(".c") && !path.endsWith(".h")) return "File name must end with .c or .h.";
  if (/[<>:"|?*]/.test(path)) return "File name contains characters Windows cannot store.";

  for (const part of path.split("/")) {
    if (!part || part === "." || part === "..") return "Path segments must be normal file or folder names.";
    const stem = part.split(".")[0].toUpperCase();
    if (reservedWindowsNames.has(stem)) return `${part} is a reserved Windows file name.`;
  }
  return undefined;
}

export function pathsEqual(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
