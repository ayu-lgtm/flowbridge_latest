import { useState } from "react";
import type { TreeNode } from "../lib/fileTree";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function iconFor(node: TreeNode): string {
  if (node.type === "folder") return "📁";
  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
    mp4: "🎞️", mov: "🎞️", mkv: "🎞️", avi: "🎞️",
    mp3: "🎵", wav: "🎵", flac: "🎵",
    pdf: "📕", doc: "📄", docx: "📄", txt: "📄", md: "📄",
    zip: "🗜️", rar: "🗜️", "7z": "🗜️", tar: "🗜️", gz: "🗜️",
    js: "📜", ts: "📜", tsx: "📜", jsx: "📜", py: "📜", java: "📜", json: "📜", html: "📜", css: "📜",
  };
  return map[ext] ?? "📄";
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);

  if (node.type === "file") {
    return (
      <div className="tree-row" style={{ paddingLeft: depth * 18 + 8 }}>
        <span className="tree-icon">{iconFor(node)}</span>
        <span className="tree-name">{node.name}</span>
        {node.size !== undefined && <span className="tree-size">{formatBytes(node.size)}</span>}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="tree-row tree-folder"
        style={{ paddingLeft: depth * 18 + 8 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tree-caret">{open ? "▾" : "▸"}</span>
        <span className="tree-icon">📁</span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-size muted">{node.children?.length ?? 0} item{node.children?.length === 1 ? "" : "s"}</span>
      </button>
      {open && node.children?.map((child) => <TreeRow key={child.path} node={child} depth={depth + 1} />)}
    </div>
  );
}

export function FileTree({ roots }: { roots: TreeNode[] }) {
  return (
    <div className="file-tree">
      {roots.map((node) => (
        <TreeRow key={node.path} node={node} depth={0} />
      ))}
    </div>
  );
}