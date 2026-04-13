import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MonacoEditor, { getLanguageFromPath } from "./components/MonacoEditor";
import TiptapEditor from "./components/tiptap/TiptapEditor";
import FileTree from "./components/FileTree";
import Terminal from "./components/Terminal";
import ChatView from "./components/ChatView";

type PermissionMode = "default" | "auto-edit" | "plan" | "bypass";

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "許可を確認",
  "auto-edit": "自動承認",
  plan: "プラン",
  bypass: "バイパス",
};

const PERMISSION_SHORT: Record<PermissionMode, string> = {
  default: "🤚",
  "auto-edit": "⚡",
  plan: "📋",
  bypass: "⚠️",
};

function buildClaudeCommand(permissionMode: PermissionMode, resumeId?: string): string {
  let cmd = "claude";
  if (resumeId) {
    cmd += ` --resume ${resumeId}`;
  }
  switch (permissionMode) {
    case "auto-edit":
      cmd += " --allowedTools Edit,Write,NotebookEdit";
      break;
    case "plan":
      cmd += " --plan";
      break;
    case "bypass":
      cmd += " --dangerously-skip-permissions";
      break;
  }
  return cmd;
}

// === Types ===

interface FileTab {
  id: string;
  title: string;
  filePath: string;
  content: string;
  /** Content as last read from / written to disk. Used to detect unsaved edits. */
  savedContent: string;
  viewMode: "code" | "preview";
}

interface TerminalSession {
  id: string;
  title: string;
  autoCommand?: string;
  cwd?: string;
  permissionMode: PermissionMode;
  resumeId?: string;
  viewMode: "cli" | "chat";
  claudeSessionId?: string; // detected from terminal output
  createdAt: number; // unix timestamp in seconds
}

interface ClaudeSession {
  id: string;
  title: string;
  project: string;
  project_path: string;
  modified: number;
  size: number;
}

const HIDDEN_SESSIONS_KEY = "claude-workspace-hidden-sessions";
const WORKSPACE_KEY = "claude-workspace-path";

function getHiddenSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_SESSIONS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* */ }
  return new Set();
}

function saveHiddenSessions(ids: Set<string>) {
  localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify([...ids]));
}

function getMcpIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("slack")) return "💬";
  if (n.includes("notion")) return "📝";
  if (n.includes("gmail") || n.includes("email")) return "📧";
  if (n.includes("drive") || n.includes("google")) return "📁";
  if (n.includes("github")) return "🐙";
  if (n.includes("jira")) return "📋";
  if (n.includes("linear")) return "📐";
  if (n.includes("postgres") || n.includes("sql") || n.includes("db")) return "🗄️";
  if (n.includes("docker")) return "🐳";
  if (n.includes("aws") || n.includes("cloud")) return "☁️";
  if (n.includes("voice") || n.includes("speech")) return "🔊";
  if (n.includes("browser") || n.includes("chrome")) return "🌐";
  if (n.includes("file") || n.includes("fs")) return "📂";
  if (n.includes("search")) return "🔍";
  if (n.includes("calendar")) return "📅";
  if (n.includes("task")) return "✅";
  if (n.includes("preview")) return "👁️";
  return "🔌";
}

function getSavedWorkspace(): string | null {
  return localStorage.getItem(WORKSPACE_KEY);
}

function saveWorkspace(path: string) {
  localStorage.setItem(WORKSPACE_KEY, path);
}

function shortenPath(path: string, homePath: string): string {
  if (path.startsWith(homePath)) {
    return "~" + path.slice(homePath.length);
  }
  return path;
}

function formatTimeAgo(unixSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(unixSec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return ext === "md" || ext === "markdown";
}

function App() {
  // File tabs (center panel)
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);

  // Terminal sessions (right panel, up to 4)
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  // Sidebar
  const [sidebarMode, setSidebarMode] = useState<"sessions" | "files" | "skills">("sessions");
  const [homePath, setHomePath] = useState("/Users");
  const [workspacePath, setWorkspacePath] = useState<string>("");
  const [defaultPermission, setDefaultPermission] = useState<PermissionMode>("default");
  const [statusMessage, setStatusMessage] = useState("");
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Centralized status helper: replaces the scattered
  // setStatusMessage(...) + setTimeout pattern with a single timer that
  // is cleared on unmount and when a new message arrives.
  const showStatus = useCallback((message: string, duration = 3000) => {
    setStatusMessage(message);
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
    }
    if (duration > 0) {
      statusTimerRef.current = setTimeout(() => {
        setStatusMessage("");
        statusTimerRef.current = null;
      }, duration);
    }
  }, []);
  // Clean up status timer on unmount
  useEffect(() => {
    return () => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };
  }, []);
  const [droppedImagePath, setDroppedImagePath] = useState<string | null>(null);
  const [permDropdownTermId, setPermDropdownTermId] = useState<string | null>(null);
  const [filePanelWidth, setFilePanelWidth] = useState(40); // percentage
  const isResizingRef = useRef(false);

  // Skills & MCP
  interface SkillInfo { name: string; display_name: string; description: string; path: string; scope: string; content: string; }
  interface McpServerInfo { name: string; command: string; args: string[]; enabled: boolean; scope: string; }
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [showMcpModal, setShowMcpModal] = useState(false);


  // History
  const [historySessions, setHistorySessions] = useState<ClaudeSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => getHiddenSessions());

  // Terminal theme
  const [termTheme, setTermTheme] = useState<"dark" | "light">("dark");

  // Sidebar resize
  const [sidebarWidth, setSidebarWidth] = useState(230);
  const isSidebarResizingRef = useRef(false);

  // Terminal grid column resize (percentage of left column)
  const [termColRatio, setTermColRatio] = useState(50);
  const isTermResizingRef = useRef(false);

  // Terminal grid row resize (percentage of top row)
  const [termRowRatio, setTermRowRatio] = useState(50);
  const isTermRowResizingRef = useRef(false);

  useEffect(() => {
    invoke<string>("get_home_dir").then((home) => {
      setHomePath(home);
      const saved = getSavedWorkspace();
      setWorkspacePath(saved || home);
    }).catch(console.error);
  }, []);

  useEffect(() => { loadHistory(); }, []);

  // Fix activeTerminalId when it becomes stale
  useEffect(() => {
    if (terminals.length > 0 && (!activeTerminalId || !terminals.find(t => t.id === activeTerminalId))) {
      setActiveTerminalId(terminals[terminals.length - 1].id);
    }
  }, [terminals, activeTerminalId]);

  // Close permission dropdown on outside click
  useEffect(() => {
    if (!permDropdownTermId) return;
    const handler = () => setPermDropdownTermId(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [permDropdownTermId]);

  // Load skills
  const loadSkills = useCallback(async () => {
    try {
      const result = await invoke<SkillInfo[]>("list_skills", { workspace: workspacePath || null });
      setSkills(result);
    } catch (err) { console.error("Failed to load skills:", err); }
  }, [workspacePath]);

  // Load MCP servers
  const loadMcpServers = useCallback(async () => {
    try {
      const result = await invoke<McpServerInfo[]>("read_mcp_servers", { workspace: workspacePath || null });
      setMcpServers(result);
    } catch (err) { console.error("Failed to load MCP servers:", err); }
  }, [workspacePath]);

  useEffect(() => { loadSkills(); loadMcpServers(); }, [loadSkills, loadMcpServers]);

  // Stage skill into active terminal's chat input (don't execute immediately)
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);

  const stageSkill = useCallback((skillName: string) => {
    const activeTermId = activeTerminalId || terminals[0]?.id;
    if (!activeTermId) return;
    setPendingSkill(`/${skillName}`);
    // Switch to chat mode if not already
    setTerminals((prev) =>
      prev.map((t) =>
        t.id === activeTermId && t.viewMode !== "chat"
          ? { ...t, viewMode: "chat" }
          : t
      )
    );
    showStatus(`/${skillName} を入力欄にセット`, 2000);
  }, [terminals, activeTerminalId]);

  // Listen for system file drops (e.g. screenshots from Finder)
  useEffect(() => {
    const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
    let unlisten: (() => void) | null = null;
    try {
      getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          for (const p of paths) {
            const lower = p.toLowerCase();
            if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
              setDroppedImagePath(p);
              return;
            }
          }
        }
      }).then((fn) => { unlisten = fn; });
    } catch { /* not in Tauri */ }
    return () => { if (unlisten) unlisten(); };
  }, []);


  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const sessions = await invoke<ClaudeSession[]>("list_claude_sessions");
      setHistorySessions(sessions);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
    setHistoryLoading(false);
  }, []);

  const hideSession = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      saveHiddenSessions(next);
      return next;
    });
  }, []);

  const clearAllHistory = useCallback(() => {
    const allIds = new Set(historySessions.map((s) => s.id));
    setHiddenIds((prev) => {
      const next = new Set([...prev, ...allIds]);
      saveHiddenSessions(next);
      return next;
    });
  }, [historySessions]);

  const restoreAllHistory = useCallback(() => {
    setHiddenIds(new Set());
    saveHiddenSessions(new Set());
  }, []);

  // === Terminal management ===

  const addTerminal = useCallback((title: string, perm: PermissionMode, cwd?: string, resumeId?: string) => {
    const cmd = buildClaudeCommand(perm, resumeId);
    const now = Math.floor(Date.now() / 1000);
    setTerminals((prev) => {
      const id = `term-${Date.now()}`;
      setActiveTerminalId(id);
      return [...prev, { id, title, autoCommand: cmd, cwd, permissionMode: perm, resumeId, viewMode: "cli", claudeSessionId: resumeId, createdAt: now }];
    });
  }, []);

  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // Update active terminal in the same state update cycle
      setActiveTerminalId((current) => {
        if (current !== id) return current;
        if (next.length === 0) return null;
        return next[next.length - 1].id;
      });
      return next;
    });
  }, []);

  // Sidebar resize handler
  const handleSidebarDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isSidebarResizingRef.current = true;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isSidebarResizingRef.current) return;
      setSidebarWidth(Math.max(160, Math.min(400, ev.clientX)));
    };
    const onMouseUp = () => {
      isSidebarResizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Terminal grid column resize handler
  const handleTermDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isTermResizingRef.current = true;
    const gridEl = (e.target as HTMLElement).closest(".term-grid");
    if (!gridEl) return;
    const rect = gridEl.getBoundingClientRect();
    const onMouseMove = (ev: MouseEvent) => {
      if (!isTermResizingRef.current) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setTermColRatio(Math.max(20, Math.min(80, pct)));
    };
    const onMouseUp = () => {
      isTermResizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Terminal grid row resize handler
  const handleTermRowDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isTermRowResizingRef.current = true;
    const gridEl = (e.target as HTMLElement).closest(".term-grid");
    if (!gridEl) return;
    const rect = gridEl.getBoundingClientRect();
    const onMouseMove = (ev: MouseEvent) => {
      if (!isTermRowResizingRef.current) return;
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setTermRowRatio(Math.max(20, Math.min(80, pct)));
    };
    const onMouseUp = () => {
      isTermRowResizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Panel resize handler
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const mainArea = (e.target as HTMLElement).closest(".main-area");
    if (!mainArea) return;
    const rect = mainArea.getBoundingClientRect();

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setFilePanelWidth(Math.max(15, Math.min(70, pct)));
    };
    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // File tab drag reorder
  const [dragTabId, setDragTabId] = useState<string | null>(null);

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    setDragTabId(tabId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleTabDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (!dragTabId || dragTabId === targetTabId) return;
    setFileTabs((prev) => {
      const tabs = [...prev];
      const fromIdx = tabs.findIndex((t) => t.id === dragTabId);
      const toIdx = tabs.findIndex((t) => t.id === targetTabId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      return tabs;
    });
    setDragTabId(null);
  }, [dragTabId]);

  // Permission is now global (defaultPermission) and applied at launch time

  // Toggle CLI/Chat view mode - auto-detect session ID when switching to chat
  const toggleTerminalView = useCallback(async (termId: string) => {
    const term = terminals.find((t) => t.id === termId);
    if (!term) return;

    if (term.viewMode === "cli") {
      // Switching to chat - detect session ID
      if (!term.claudeSessionId) {
        try {
          const cwd = term.cwd || workspacePath || homePath;
          // Only find sessions created after this terminal was started
          const sessionId = await invoke<string>("find_active_session", {
            cwd,
            afterTs: term.createdAt || 0,
          });
          setTerminals((prev) =>
            prev.map((t) =>
              t.id === termId
                ? { ...t, viewMode: "chat", claudeSessionId: sessionId }
                : t
            )
          );
          return;
        } catch (err) {
          console.error("Failed to find session:", err);
        }
      }
      // Switch to chat with existing session ID
      setTerminals((prev) =>
        prev.map((t) =>
          t.id === termId ? { ...t, viewMode: "chat" } : t
        )
      );
    } else {
      // Switch back to CLI
      setTerminals((prev) =>
        prev.map((t) =>
          t.id === termId ? { ...t, viewMode: "cli" } : t
        )
      );
    }
  }, [terminals, workspacePath, homePath]);

  // Send message from chat to terminal PTY
  const sendChatMessage = useCallback((termId: string, text: string) => {
    invoke("write_pty", { id: termId, data: text + "\r" }).catch((err) => {
      console.error("write_pty (chat) failed:", err);
      showStatus(`メッセージ送信に失敗: ${err}`, 4000);
    });
  }, [showStatus]);

  // Open a NEW terminal with different folder (keep old one)
  const openTerminalInFolder = useCallback(async (termId: string) => {
    const term = terminals.find((t) => t.id === termId);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: term?.cwd || workspacePath || homePath,
        title: "Select Workspace Folder",
      });
      if (selected) {
        const path = typeof selected === "string" ? selected : selected;
        const folderName = path.split("/").pop() || path;
        addTerminal(`Claude (${folderName})`, defaultPermission, path);
      }
    } catch (err) {
      console.error("Failed to open folder dialog:", err);
    }
  }, [terminals, workspacePath, homePath, defaultPermission, addTerminal]);

  const launchNewSession = useCallback(() => {
    addTerminal(`Claude ${terminals.length + 1}`, defaultPermission, workspacePath);
  }, [terminals.length, defaultPermission, workspacePath, addTerminal]);

  const resumeSession = useCallback(
    (session: ClaudeSession) => {
      const shortTitle = session.title.length > 25
        ? session.title.substring(0, 25) + "..."
        : session.title;
      const cwd = session.project_path || workspacePath;
      addTerminal(shortTitle, defaultPermission, cwd, session.id);
    },
    [defaultPermission, workspacePath, addTerminal]
  );

  const selectWorkspaceFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: workspacePath || homePath,
        title: "Select Workspace Folder",
      });
      if (selected) {
        const path = typeof selected === "string" ? selected : selected;
        setWorkspacePath(path);
        saveWorkspace(path);
        showStatus(`Workspace: ${path}`);
      }
    } catch (err) {
      console.error("Failed to open folder dialog:", err);
    }
  }, [workspacePath, homePath]);

  // === File tab management ===

  const openFile = useCallback(
    async (filePath: string, fileName?: string) => {
      const name = fileName || filePath.split("/").pop() || "file";
      const existing = fileTabs.find((t) => t.filePath === filePath);
      if (existing) {
        setActiveFileTabId(existing.id);
        return;
      }
      try {
        const content = await invoke<string>("read_file", { path: filePath });
        const id = `file-${Date.now()}`;
        const viewMode = isMarkdownFile(filePath) ? "preview" : "code";
        setFileTabs((prev) => [
          ...prev,
          { id, title: name, filePath, content, savedContent: content, viewMode },
        ]);
        setActiveFileTabId(id);
        showStatus(`Opened ${name}`);
      } catch (err) {
        showStatus(`Error: ${err}`);
      }
    },
    [fileTabs, showStatus]
  );

  const closeFileTab = useCallback(
    async (id: string) => {
      // Unsaved-changes guard: if the tab has uncommitted edits, confirm.
      const target = fileTabs.find((t) => t.id === id);
      if (target && target.content !== target.savedContent) {
        const ok = await ask(
          `"${target.title}" には未保存の変更があります。閉じて変更を破棄しますか？`,
          { title: "未保存の変更", kind: "warning" }
        );
        if (!ok) return;
      }
      setFileTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        const next = prev.filter((t) => t.id !== id);
        setActiveFileTabId((current) => {
          if (current !== id) return current;
          if (next.length === 0) return null;
          return next[Math.min(idx, next.length - 1)].id;
        });
        return next;
      });
    },
    [fileTabs]
  );

  const saveFile = useCallback(
    async (content: string) => {
      const tab = fileTabs.find((t) => t.id === activeFileTabId);
      if (!tab?.filePath) return;
      try {
        await invoke("write_file", { path: tab.filePath, content });
        setFileTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id ? { ...t, content, savedContent: content } : t
          )
        );
        showStatus(`Saved ${tab.title}`);
      } catch (err) {
        showStatus(`Error saving: ${err}`, 0);
      }
    },
    [activeFileTabId, fileTabs, showStatus]
  );

  const updateFileContent = useCallback((tabId: string, content: string) => {
    setFileTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, content } : t))
    );
  }, []);

  const toggleViewMode = useCallback((tabId: string) => {
    setFileTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? { ...t, viewMode: t.viewMode === "code" ? "preview" : "code" }
          : t
      )
    );
  }, []);

  const handleTerminalFileClick = useCallback(
    (filePath: string) => { openFile(filePath); },
    [openFile]
  );

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId);
  const visibleSessions = historySessions.filter((s) => !hiddenIds.has(s.id));
  const hiddenCount = historySessions.length - visibleSessions.length;

  const termGridClass =
    terminals.length <= 1
      ? "term-grid-1"
      : terminals.length === 2
        ? "term-grid-2"
        : terminals.length <= 4
          ? "term-grid-4"
          : terminals.length === 5
            ? "term-grid-5"
            : terminals.length <= 6
              ? "term-grid-6"
              : "term-grid-many";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div className="titlebar">
        <span className="titlebar-title">Necode</span>
      </div>

      <div className="workspace">
        {/* === サイドバー === */}
        <div className="sidebar" style={{ width: sidebarWidth, minWidth: 160 }}>
          <div className="sidebar-toggle">
            <button
              className={`toggle-btn ${sidebarMode === "sessions" ? "active" : ""}`}
              onClick={() => setSidebarMode("sessions")}
            >
              Sessions
            </button>
            <button
              className={`toggle-btn ${sidebarMode === "files" ? "active" : ""}`}
              onClick={() => setSidebarMode("files")}
            >
              Files
            </button>
            <button
              className={`toggle-btn ${sidebarMode === "skills" ? "active" : ""}`}
              onClick={() => { setSidebarMode("skills"); loadSkills(); }}
            >
              Skills
            </button>
          </div>

          {sidebarMode === "sessions" ? (
            <div className="session-list">
              <div className="sidebar-header">
                <h2>Active</h2>
                <button className="sidebar-btn" onClick={launchNewSession}>
                  + New
                </button>
              </div>
              {terminals.map((term) => (
                <div
                  key={term.id}
                  className={`session-item ${term.id === activeTerminalId ? "active" : ""}`}
                  onClick={() => setActiveTerminalId(term.id)}
                >
                  <div className="session-title">
                    <span className="session-status running" />
                    <span className="session-title-text">{term.title}</span>
                    <span
                      className="session-hide-btn"
                      onClick={(e) => { e.stopPropagation(); closeTerminal(term.id); }}
                      title="Close"
                    >
                      ×
                    </span>
                  </div>
                </div>
              ))}
              {terminals.length === 0 && (
                <div style={{ padding: "8px 12px", color: "var(--text-muted)", fontSize: 11 }}>
                  No active terminals
                </div>
              )}

              <div className="sidebar-header" style={{ marginTop: 8 }}>
                <h2>History</h2>
                <div style={{ display: "flex", gap: 4 }}>
                  {hiddenCount > 0 && (
                    <button className="sidebar-btn" onClick={restoreAllHistory} title={`Restore ${hiddenCount}`}>
                      {hiddenCount}
                    </button>
                  )}
                  {visibleSessions.length > 0 && (
                    <button className="sidebar-btn" onClick={clearAllHistory}>Clear</button>
                  )}
                  <button className="sidebar-btn" onClick={loadHistory}>
                    {historyLoading ? "..." : "↻"}
                  </button>
                </div>
              </div>
              {visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className="session-item history-item"
                  onClick={() => resumeSession(session)}
                  title={`${session.title}\n${session.project_path}\n${formatSize(session.size)}`}
                >
                  <div className="session-title">
                    <span className="session-status stopped" />
                    <span className="session-title-text">{session.title}</span>
                    <span
                      className="session-hide-btn"
                      onClick={(e) => hideSession(session.id, e)}
                    >
                      ×
                    </span>
                  </div>
                  <div className="session-meta">
                    {formatTimeAgo(session.modified)} · {formatSize(session.size)}
                  </div>
                </div>
              ))}
              {!historyLoading && visibleSessions.length === 0 && historySessions.length === 0 && (
                <div style={{ padding: "8px 12px", color: "var(--text-muted)", fontSize: 11 }}>
                  No session history
                </div>
              )}
              {!historyLoading && visibleSessions.length === 0 && hiddenCount > 0 && (
                <div style={{ padding: "8px 12px", color: "var(--text-muted)", fontSize: 11, textAlign: "center" }}>
                  All hidden ·{" "}
                  <span style={{ color: "var(--accent)", cursor: "pointer" }} onClick={restoreAllHistory}>
                    Restore
                  </span>
                </div>
              )}
            </div>
          ) : sidebarMode === "files" ? (
            <FileTree onFileSelect={openFile} rootPath={workspacePath || homePath} />
          ) : (
            /* Skills panel */
            <div className="session-list">
              <div className="sidebar-header">
                <h2>Skills</h2>
                <button className="sidebar-btn" onClick={() => setShowMcpModal(true)}>
                  🔌 MCP
                </button>
              </div>

              {/* CLAUDE.md quick access */}
              <div
                className="session-item skill-claudemd"
                onClick={() => {
                  const claudeMdPath = (workspacePath || homePath) + "/CLAUDE.md";
                  openFile(claudeMdPath, "CLAUDE.md");
                }}
              >
                <div className="session-title">
                  <span className="skill-icon">📋</span>
                  <span className="session-title-text">CLAUDE.md</span>
                </div>
                <div className="session-meta">プロジェクトルール編集</div>
              </div>

              <div className="sidebar-header" style={{ marginTop: 8 }}>
                <h2>Commands ({skills.length})</h2>
                <button className="sidebar-btn" onClick={loadSkills}>↻</button>
              </div>

              {skills.length === 0 && (
                <div style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-muted)" }}>
                  スキルが見つかりません
                </div>
              )}

              {/* Group by scope */}
              {["skill", "scheduled", "plugin", "command", "project"].map((scope) => {
                const scopeSkills = skills.filter((s) => s.scope === scope);
                if (scopeSkills.length === 0) return null;
                const labels: Record<string, string> = {
                  skill: "⚡ スキル",
                  scheduled: "⏰ スケジュール",
                  plugin: "🧩 プラグイン",
                  command: "🔧 コマンド",
                  project: "📂 プロジェクト",
                };
                return (
                  <div key={scope}>
                    <div style={{ padding: "6px 14px 2px", fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>
                      {labels[scope] || scope}
                    </div>
                    {scopeSkills.map((skill) => (
                <div
                  key={skill.path}
                  className="session-item skill-item"
                  onClick={() => stageSkill(skill.name)}
                  title={`/${skill.name} — ${skill.description}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", `/${skill.name}`);
                    e.dataTransfer.setData("application/x-claude-skill", skill.name);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <div className="session-title">
                    <span className="skill-icon">{
                      skill.scope === "project" ? "📂" :
                      skill.scope === "scheduled" ? "⏰" :
                      skill.scope === "plugin" ? "🧩" :
                      skill.scope === "skill" ? "⚡" : "🔧"
                    }</span>
                    <span className="session-title-text">/{skill.name}</span>
                  </div>
                  <div className="session-meta">{skill.description || skill.display_name}</div>
                  <button
                    className="session-hide-btn"
                    onClick={(e) => { e.stopPropagation(); openFile(skill.path, skill.name + ".md"); }}
                    title="編集"
                  >
                    ✏️
                  </button>
                </div>
              ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* MCP Modal */}
          {showMcpModal && (
            <div className="mcp-modal-overlay" onClick={() => setShowMcpModal(false)}>
              <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
                <div className="mcp-modal-header">
                  <h3>🔌 MCP Servers</h3>
                  <button className="mcp-modal-close" onClick={() => setShowMcpModal(false)}>✕</button>
                </div>
                <div className="mcp-modal-body">
                  {mcpServers.length === 0 && (
                    <div className="mcp-empty">MCP サーバーが設定されていません</div>
                  )}
                  <div className="mcp-grid">
                    {mcpServers.map((server) => (
                      <div key={server.name} className={`mcp-card ${server.enabled ? "" : "mcp-card-disabled"}`}>
                        <div className="mcp-card-icon">{getMcpIcon(server.name)}</div>
                        <div className="mcp-card-name">{server.name}</div>
                        <div className="mcp-card-status">
                          <span className={`mcp-dot ${server.enabled ? "mcp-dot-active" : ""}`} />
                          {server.enabled ? "有効" : "無効"}
                        </div>
                        <div className="mcp-card-scope">
                          {server.scope === "project" ? "プロジェクト" : server.scope === "plugin" ? "プラグイン" : server.scope === "inferred" ? "検出" : "ユーザー"}
                        </div>
                        {(server.scope !== "inferred") && (
                          <button
                            className={`mcp-toggle-btn ${server.enabled ? "mcp-toggle-off" : "mcp-toggle-on"}`}
                            onClick={async () => {
                              const action = server.enabled ? "無効" : "有効";
                              if (confirm(`⚠️ ${server.name} を${action}にしますか？\n\n設定ファイルが変更されます。\nClaude Codeの再起動が必要です。`)) {
                                try {
                                  await invoke("toggle_mcp_server", { name: server.name, enabled: !server.enabled });
                                  loadMcpServers();
                                  showStatus(`${server.name} を${action}にしました（再起動が必要）`, 4000);
                                } catch (err) { console.error(err); }
                              }
                            }}
                          >
                            {server.enabled ? "無効にする" : "有効にする"}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="sidebar-divider" onMouseDown={handleSidebarDividerMouseDown} />

        {/* === メインエリア === */}
        <div className="main-area">
          {/* ファイルビューパネル */}
          <div className="file-panel" style={{ width: `${filePanelWidth}%`, minWidth: 200 }}>
            <div className="tab-bar">
              {fileTabs.map((tab) => {
                const isDirty = tab.content !== tab.savedContent;
                return (
                  <div
                    key={tab.id}
                    className={`tab ${tab.id === activeFileTabId ? "active" : ""} ${dragTabId === tab.id ? "tab-dragging" : ""}`}
                    onClick={() => setActiveFileTabId(tab.id)}
                    title={isDirty ? `${tab.filePath} (未保存)` : tab.filePath}
                    draggable
                    onDragStart={(e) => handleTabDragStart(e, tab.id)}
                    onDragOver={handleTabDragOver}
                    onDrop={(e) => handleTabDrop(e, tab.id)}
                    onDragEnd={() => setDragTabId(null)}
                  >
                    <span title={tab.filePath}>📄</span>
                    <span className="tab-label">
                      {tab.title}
                      {isDirty && (
                        <span
                          style={{ marginLeft: 4, color: "#d97706" }}
                          aria-label="未保存"
                        >
                          ●
                        </span>
                      )}
                    </span>
                    <span
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        void closeFileTab(tab.id);
                      }}
                    >
                      ×
                    </span>
                  </div>
                );
              })}
              {fileTabs.length === 0 && (
                <div className="tab-placeholder">Files</div>
              )}
              <div style={{ flex: 1 }} />
            </div>

            <div className="file-panel-body">
              {fileTabs.length === 0 && (
                <div className="file-panel-empty">
                  <div style={{ fontSize: 24, opacity: 0.2 }}>📄</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                    ファイルをクリックで表示
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Files タブまたはCLI上のパスから
                  </div>
                </div>
              )}
              {fileTabs.map((tab) => (
                <div
                  key={tab.id}
                  className="file-panel-content"
                  style={{ display: tab.id === activeFileTabId ? "flex" : "none" }}
                >
                  {tab.viewMode === "preview" && isMarkdownFile(tab.filePath) ? (
                    <TiptapEditor
                      content={tab.content}
                      filePath={tab.filePath}
                      onChange={(val) => updateFileContent(tab.id, val)}
                      onSave={saveFile}
                    />
                  ) : (
                    <div style={{ width: "100%", height: "100%" }}>
                      <MonacoEditor
                        filePath={tab.filePath}
                        content={tab.content}
                        language={getLanguageFromPath(tab.filePath)}
                        onSave={saveFile}
                        onChange={(val) => updateFileContent(tab.id, val)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="panel-divider" onMouseDown={handleDividerMouseDown} />

          {/* ターミナルグリッドパネル */}
          <div className="terminal-panel">
            {/* 上部ヘッダー: 許可 + フォルダ + テーマ + 新規 */}
            <div className="term-panel-header">
              {/* グローバル許可モード */}
              <div
                className="cell-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  setPermDropdownTermId(permDropdownTermId ? null : "__global__");
                }}
                title="許可レベルを選択（新規CLIに適用）"
                style={{ position: "relative" }}
              >
                <span>{PERMISSION_SHORT[defaultPermission]}</span>
                <span className="cell-chip-label">{PERMISSION_LABELS[defaultPermission]}</span>
                <span className="config-arrow">▾</span>
                {permDropdownTermId === "__global__" && (
                  <div className="config-dropdown" onClick={(e) => e.stopPropagation()}>
                    {(["default", "auto-edit", "plan", "bypass"] as PermissionMode[]).map((mode) => (
                      <div
                        key={mode}
                        className={`config-dropdown-item ${defaultPermission === mode ? "active" : ""}`}
                        onClick={() => { setDefaultPermission(mode); setPermDropdownTermId(null); }}
                      >
                        <span style={{ width: 20, textAlign: "center" }}>{PERMISSION_SHORT[mode]}</span>
                        <div>
                          <div style={{ fontWeight: 600 }}>{PERMISSION_LABELS[mode]}</div>
                          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                            {mode === "default" ? "変更前に常に確認する" :
                             mode === "auto-edit" ? "ファイル編集を自動承認" :
                             mode === "plan" ? "変更前に計画を作成" :
                             "すべての権限を承認"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* グローバルフォルダ */}
              <div
                className="cell-chip"
                onClick={async (e) => {
                  e.stopPropagation();
                  const selected = await open({ directory: true, defaultPath: workspacePath || homePath });
                  if (selected && typeof selected === "string") {
                    setWorkspacePath(selected);
                    saveWorkspace(selected);
                  }
                }}
                title="ワークスペースフォルダを変更"
              >
                <span>📁</span>
                <span className="cell-chip-label">{shortenPath(workspacePath, homePath)}</span>
              </div>

              <div style={{ flex: 1 }} />
              <button
                className="term-header-btn"
                onClick={() => setTermTheme(termTheme === "dark" ? "light" : "dark")}
                title={`Switch to ${termTheme === "dark" ? "light" : "dark"} mode`}
              >
                {termTheme === "dark" ? "☀️" : "🌙"}
              </button>
              <button
                className="term-header-btn primary"
                onClick={launchNewSession}
                title="New terminal"
              >
                + New
              </button>
            </div>

            {terminals.length === 0 ? (
              <div className="placeholder">
                <div className="placeholder-icon">✦</div>
                <div className="placeholder-text">Necode</div>
                <div className="placeholder-hint">
                  「+ New」でClaude Codeを起動するか、
                  <br />
                  Historyからセッションを再開してください
                </div>
              </div>
            ) : (
              <div
                className={`term-grid ${termGridClass}`}
                style={
                  terminals.length === 2
                    ? { gridTemplateColumns: `${termColRatio}% 3px ${100 - termColRatio}%` }
                    : terminals.length >= 3 && terminals.length <= 6
                      ? { gridTemplateRows: `${termRowRatio}% 3px ${100 - termRowRatio}%` }
                      : undefined
                }
              >
                {terminals.map((term, idx) => (
                  <React.Fragment key={term.id}>
                    {/* Add column divider between the first and second column (2 terminals) */}
                    {terminals.length === 2 && idx === 1 && (
                      <div className="term-grid-divider" onMouseDown={handleTermDividerMouseDown} />
                    )}
                    {/* Add row divider between rows (3-6 terminals) */}
                    {terminals.length >= 3 && terminals.length <= 6 && idx === (terminals.length <= 4 ? 2 : 3) && (
                      <div
                        className="term-grid-row-divider"
                        onMouseDown={handleTermRowDividerMouseDown}
                        style={{ gridColumn: "1 / -1" }}
                      />
                    )}
                  <div className="term-cell">
                    <div className="term-cell-header">
                      <span className="term-cell-dot" />
                      <span className="term-cell-title">{term.title}</span>

                      {/* CLI/Chat切替 */}
                      <div
                        className={`cell-chip ${term.viewMode === "chat" ? "cell-chip-active" : ""}`}
                        onClick={(e) => { e.stopPropagation(); toggleTerminalView(term.id); }}
                        title={term.viewMode === "cli" ? "チャット表示に切替" : "CLI表示に切替"}
                      >
                        <span>{term.viewMode === "cli" ? "💬" : "⌨️"}</span>
                        <span className="cell-chip-label">{term.viewMode === "cli" ? "Chat" : "CLI"}</span>
                      </div>

                      <button
                        className="term-cell-close"
                        onClick={() => closeTerminal(term.id)}
                        title="Close"
                      >
                        ×
                      </button>
                    </div>
                    <div className="term-cell-body">
                      {/* CLIとChatの両方をDOMに保持 (absolute overlay で切替) */}
                      <div style={{ position: "absolute", inset: 0, display: term.viewMode === "cli" ? "block" : "none" }}>
                        <Terminal
                          id={term.id}
                          cwd={term.cwd}
                          autoCommand={term.autoCommand}
                          onFileClick={handleTerminalFileClick}
                          theme={termTheme}
                          visible={term.viewMode === "cli"}
                        />
                      </div>
                      <div style={{ position: "absolute", inset: 0, display: term.viewMode === "chat" ? "flex" : "none" }}>
                        <ChatView
                          terminalId={term.id}
                          sessionId={term.claudeSessionId}
                          workspacePath={workspacePath || homePath}
                          droppedImagePath={droppedImagePath}
                          onDroppedImageHandled={() => setDroppedImagePath(null)}
                          stagedText={pendingSkill}
                          onStagedTextHandled={() => setPendingSkill(null)}
                          onSendMessage={(text) => sendChatMessage(term.id, text)}
                          onFileOpen={openFile}
                          visible={term.viewMode === "chat"}
                        />
                      </div>
                    </div>
                  </div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ステータスバー */}
      <div className="statusbar">
        <span>
          {terminals.length} terminal{terminals.length !== 1 ? "s" : ""}
          {fileTabs.length > 0 ? ` · ${fileTabs.length} file${fileTabs.length !== 1 ? "s" : ""}` : ""}
          {activeFileTab ? ` · ${getLanguageFromPath(activeFileTab.filePath)}` : ""}
        </span>
        <span>{statusMessage || "Necode v0.4.0"}</span>
      </div>
    </div>
  );
}

export default App;
