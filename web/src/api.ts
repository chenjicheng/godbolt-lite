import type { CompileResponse, ProjectState, RunResponse, SourceReadResponse, StatusResponse } from "./types";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchStatus(): Promise<StatusResponse> {
  return jsonFetch<StatusResponse>("/api/status");
}

export function fetchProject(): Promise<ProjectState> {
  return jsonFetch<ProjectState>("/api/project");
}

export function syncProject(project: ProjectState): Promise<ProjectState> {
  return jsonFetch<ProjectState>("/api/project/sync", {
    method: "POST",
    body: JSON.stringify(project)
  });
}

export function compile(activeFile: string, compilerArgs: string, requestId: string): Promise<CompileResponse> {
  return jsonFetch<CompileResponse>("/api/compile", {
    method: "POST",
    body: JSON.stringify({ activeFile, compilerArgs, requestId })
  });
}

export function runProgram(activeFile: string, compilerArgs: string, requestId: string): Promise<RunResponse> {
  return jsonFetch<RunResponse>("/api/run", {
    method: "POST",
    body: JSON.stringify({ activeFile, compilerArgs, requestId })
  });
}

export function readSource(uri: string): Promise<SourceReadResponse> {
  return jsonFetch<SourceReadResponse>("/api/source/read", {
    method: "POST",
    body: JSON.stringify({ uri })
  });
}
