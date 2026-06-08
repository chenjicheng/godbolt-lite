import type { ProjectState } from "./types";

export function cloneProject(state: ProjectState): ProjectState {
  return {
    activeFile: state.activeFile,
    compilerArgs: state.compilerArgs,
    files: state.files.map((file) => ({ path: file.path, content: file.content }))
  };
}

export function isProjectStateLike(value: unknown): value is ProjectState {
  if (!value || typeof value !== "object") return false;

  const state = value as Partial<ProjectState>;
  return (
    typeof state.activeFile === "string" &&
    typeof state.compilerArgs === "string" &&
    Array.isArray(state.files) &&
    state.files.every((file) => typeof file.path === "string" && typeof file.content === "string")
  );
}

export function projectFingerprint(state: ProjectState): string {
  const stableProject = {
    activeFile: state.activeFile,
    compilerArgs: state.compilerArgs,
    files: [...state.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, content: file.content }))
  };
  return hashString(JSON.stringify(stableProject));
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
