export type ProjectFile = {
  path: string;
  content: string;
};

export type ProjectState = {
  files: ProjectFile[];
  activeFile: string;
  compilerArgs: string;
};

export type CompileResponse = {
  ok: boolean;
  asm: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  requestId: string;
  error?: string;
};

export type RunResponse = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  requestId: string;
  error?: string;
  note?: string;
};

export type StatusResponse = {
  projectDir: string;
  systemIncludeDir: string;
  cacheDir: string;
  toolchain: string;
  ready: boolean;
};

export type SourceReadResponse = {
  uri: string;
  path: string;
  content: string;
  readOnly: boolean;
};
