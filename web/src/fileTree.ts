import type { ProjectFile } from "./types";

export type FileTreeNode = FileTreeFolder | FileTreeFile;

export type FileTreeFolder = {
  kind: "folder";
  path: string;
  name: string;
  children: FileTreeNode[];
};

export type FileTreeFile = {
  kind: "file";
  path: string;
  name: string;
  file: ProjectFile;
};

type MutableFolder = FileTreeFolder & {
  folders: Map<string, MutableFolder>;
  files: FileTreeFile[];
};

export function buildFileTree(files: ProjectFile[]): FileTreeNode[] {
  const root: MutableFolder = { kind: "folder", path: "", name: "", children: [], folders: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    let currentPath = "";

    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folderKey = pathKey(part);
      let folder = current.folders.get(folderKey);
      if (!folder) {
        folder = { kind: "folder", path: currentPath, name: part, children: [], folders: new Map(), files: [] };
        current.folders.set(folderKey, folder);
      } else {
        currentPath = folder.path;
      }
      current = folder;
    }

    current.files.push({
      kind: "file",
      path: file.path,
      name: parts.at(-1) ?? file.path,
      file
    });
  }

  return finalizeFolder(root);
}

export function fileDisplayName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function parentFolderPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

export function pathInsideFolder(path: string, folderPath: string): boolean {
  const source = pathKey(path);
  const folder = pathKey(folderPath);
  return source === folder || source.startsWith(`${folder}/`);
}

export function childPathInFolder(folderPath: string, childName: string): string {
  return folderPath ? `${folderPath}/${childName}` : childName;
}

export function folderAncestorPaths(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  const ancestors: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    ancestors.push(current);
  }
  return ancestors;
}

function finalizeFolder(folder: MutableFolder): FileTreeNode[] {
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...folder.files].sort((a, b) => a.name.localeCompare(b.name));

  for (const child of folders) {
    child.children = finalizeFolder(child);
  }
  return [...folders, ...files];
}

function pathKey(path: string): string {
  return path.toLowerCase();
}
