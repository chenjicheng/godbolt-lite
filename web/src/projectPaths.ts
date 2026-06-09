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
  const pathError = validateEditablePathSegments(path, "File");
  if (pathError) return pathError;
  if (!path.endsWith(".c") && !path.endsWith(".h") && !path.endsWith(".inc")) {
    return "File name must end with .c, .h, or .inc.";
  }
  return undefined;
}

export function validateEditableFolderPath(path: string): string | undefined {
  return validateEditablePathSegments(path, "Folder");
}

function validateEditablePathSegments(path: string, label: "File" | "Folder"): string | undefined {
  if (!path) return `${label} name is required.`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "Absolute paths are not allowed.";
  if (path === "external" || path.startsWith("external/")) return "The external/ namespace is reserved for read-only includes.";
  if (path === ".mini-godbolt-run" || path.startsWith(".mini-godbolt-run/")) {
    return "The .mini-godbolt-run/ namespace is reserved for runtime output.";
  }
  if (/[<>:"|?*]/.test(path)) return "File name contains characters Windows cannot store.";

  for (const part of path.split("/")) {
    if (!part || part === "." || part === "..") return "Path segments must be normal file or folder names.";
    const stem = part.split(".")[0].toUpperCase();
    if (reservedWindowsNames.has(stem)) return `${part} is a reserved Windows file name.`;
  }
  if (label === "Folder" && /\.(c|h|inc)$/i.test(path.split("/").at(-1) ?? "")) {
    return "Folder name should not look like a source file.";
  }
  return undefined;
}

export function pathsEqual(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
