import JSZip from "jszip";

export interface TreeNode {
  name: string;
  /** Full path from the archive/selection root, e.g. "src/components/App.tsx" */
  path: string;
  type: "file" | "folder";
  size?: number;
  children?: TreeNode[];
}

export interface FileTreeResult {
  /** Top-level nodes. For a plain (non-zip) file this is a single file node. */
  roots: TreeNode[];
  isArchive: boolean;
  fileCount: number;
  totalSize: number;
}

const ZIP_EXTENSIONS = [".zip"];

function looksLikeZip(name: string): boolean {
  const lower = name.toLowerCase();
  return ZIP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function buildTreeFromPaths(entries: Array<{ path: string; size: number; isDir: boolean }>): TreeNode[] {
  const rootChildren: TreeNode[] = [];
  const folderIndex = new Map<string, TreeNode>();

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const parts = entry.path.split("/").filter(Boolean);
    let currentChildren = rootChildren;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (isLast && !entry.isDir) {
        currentChildren.push({ name: part, path: currentPath, type: "file", size: entry.size });
        continue;
      }

      let folder = folderIndex.get(currentPath);
      if (!folder) {
        folder = { name: part, path: currentPath, type: "folder", children: [] };
        folderIndex.set(currentPath, folder);
        currentChildren.push(folder);
      }
      currentChildren = folder.children!;
    }
  }

  return rootChildren;
}

function countFiles(nodes: TreeNode[]): { count: number; size: number } {
  let count = 0;
  let size = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      count += 1;
      size += node.size ?? 0;
    } else if (node.children) {
      const inner = countFiles(node.children);
      count += inner.count;
      size += inner.size;
    }
  }
  return { count, size };
}

export async function buildFileTree(file: File | Blob, fileName: string): Promise<FileTreeResult> {
  if (!looksLikeZip(fileName)) {
    const size = "size" in file ? file.size : 0;
    return {
      roots: [{ name: fileName, path: fileName, type: "file", size }],
      isArchive: false,
      fileCount: 1,
      totalSize: size,
    };
  }

  const zip = await JSZip.loadAsync(file);
  const entries: Array<{ path: string; size: number; isDir: boolean }> = [];
  zip.forEach((relativePath, zipEntry) => {
    entries.push({
      path: relativePath,
      size: (zipEntry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      isDir: zipEntry.dir,
    });
  });

  const roots = buildTreeFromPaths(entries);
  const { count, size } = countFiles(roots);
  return { roots, isArchive: true, fileCount: count, totalSize: size };
}