import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  extension: string;
  size: number;
}

interface FileTreeProps {
  onFileSelect: (path: string, name: string) => void;
  rootPath: string;
}

function getFileIcon(entry: FileEntry): string {
  if (entry.is_dir) return "📁";
  const ext = entry.extension.toLowerCase();
  const icons: Record<string, string> = {
    md: "📝", markdown: "📝", json: "{}", js: "JS", ts: "TS",
    tsx: "⚛️", jsx: "⚛️", py: "🐍", rs: "🦀", html: "🌐",
    css: "🎨", yaml: "⚙️", yml: "⚙️", toml: "⚙️", sh: "🔧",
    txt: "📄", png: "🖼️", jpg: "🖼️", svg: "🖼️",
  };
  return icons[ext] || "📄";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Drag handler for file items
function handleFileDragStart(e: React.DragEvent, entry: FileEntry) {
  e.dataTransfer.setData("text/plain", entry.path);
  e.dataTransfer.setData("application/x-claude-file", JSON.stringify({
    path: entry.path,
    name: entry.name,
    is_dir: entry.is_dir,
    extension: entry.extension,
  }));
  e.dataTransfer.effectAllowed = "copy";
}

function FileItem({
  entry,
  depth,
  onFileSelect,
}: {
  entry: FileEntry;
  depth: number;
  onFileSelect: (path: string, name: string) => void;
}) {
  return (
    <div
      className="file-tree-item"
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => onFileSelect(entry.path, entry.name)}
      title={entry.path}
      draggable
      onDragStart={(e) => handleFileDragStart(e, entry)}
    >
      <span className="file-tree-icon" title={entry.name}>{getFileIcon(entry)}</span>
      <span className="file-tree-name">{entry.name}</span>
      <span className="file-tree-size">{formatSize(entry.size)}</span>
    </div>
  );
}

function DirectoryNode({
  entry,
  onFileSelect,
  depth,
}: {
  entry: FileEntry;
  onFileSelect: (path: string, name: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (!expanded && children.length === 0) {
      setLoading(true);
      try {
        const result = await invoke<FileEntry[]>("list_directory", { path: entry.path });
        setChildren(result);
      } catch (err) {
        console.error("Failed to list directory:", err);
      }
      setLoading(false);
    }
    setExpanded(!expanded);
  }, [expanded, children.length, entry.path]);

  return (
    <div>
      <div
        className="file-tree-item"
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={toggle}
        title={entry.path}
        draggable
        onDragStart={(e) => handleFileDragStart(e, entry)}
      >
        <span className="file-tree-arrow">{expanded ? "▼" : "▶"}</span>
        <span className="file-tree-icon" title={entry.name}>📁</span>
        <span className="file-tree-name">{entry.name}</span>
      </div>
      {expanded && (
        <div>
          {loading && (
            <div className="file-tree-item" style={{ paddingLeft: 8 + (depth + 1) * 16, color: "var(--text-muted)" }}>
              Loading...
            </div>
          )}
          {children.map((child) =>
            child.is_dir ? (
              <DirectoryNode key={child.path} entry={child} onFileSelect={onFileSelect} depth={depth + 1} />
            ) : (
              <FileItem key={child.path} entry={child} depth={depth + 1} onFileSelect={onFileSelect} />
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ onFileSelect, rootPath }: FileTreeProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async (path: string) => {
    try {
      const result = await invoke<FileEntry[]>("list_directory", { path });
      setEntries(result);
      setCurrentPath(path);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    loadDirectory(rootPath);
  }, [rootPath, loadDirectory]);

  const goUp = useCallback(() => {
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    loadDirectory(parent);
  }, [currentPath, loadDirectory]);

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <button className="file-tree-up" onClick={goUp} title="Go up">↑</button>
        <span className="file-tree-path" title={currentPath}>
          {currentPath.split("/").pop() || "/"}
        </span>
        <button className="file-tree-up" onClick={() => loadDirectory(currentPath)} title="Refresh">↻</button>
      </div>
      <div className="file-tree-content">
        {error && (
          <div style={{ padding: 12, color: "var(--accent-red)", fontSize: 11 }}>{error}</div>
        )}
        {entries.map((entry) =>
          entry.is_dir ? (
            <DirectoryNode key={entry.path} entry={entry} onFileSelect={onFileSelect} depth={0} />
          ) : (
            <FileItem key={entry.path} entry={entry} depth={0} onFileSelect={onFileSelect} />
          )
        )}
      </div>
    </div>
  );
}
