import type { RunResponse } from "./types";

export function formatRunOutput(result: RunResponse): string {
  const sections = [result.note, result.error, result.stdout].filter(Boolean) as string[];
  if (result.stderr) {
    sections.push(result.stdout ? `stderr:\n${result.stderr}` : result.stderr);
  }
  sections.push(`[exit code: ${result.exitCode}]`);
  return sections.join("\n\n");
}
