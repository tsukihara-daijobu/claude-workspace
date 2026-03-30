import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./ChatView.css";

interface ChatMessage {
  role: string;
  content: string;
  thinking: string;
  tool_name: string;
  timestamp: string;
  msg_type: string;
}

interface PendingMsg {
  text: string;
  imagePath?: string;
  imageDataUrl?: string; // for preview
}

interface FileSearchResult {
  name: string;
  path: string;
  is_dir: boolean;
}

interface ChatViewProps {
  terminalId: string;
  sessionId?: string;
  workspacePath?: string;
  droppedImagePath?: string | null;
  onDroppedImageHandled?: () => void;
  stagedText?: string | null;
  onStagedTextHandled?: () => void;
  onSendMessage: (text: string) => void;
  onFileOpen?: (path: string, name: string) => void;
  visible?: boolean;
}

// Detect system messages (hook feedback, task notifications, system reminders)
function isSystemMessage(content: string): boolean {
  return (
    content.includes("<system-reminder>") ||
    content.includes("<task-notification>") ||
    content.includes("Stop hook feedback:") ||
    content.includes("Stop:Callback hook") ||
    content.includes("<user-prompt-submit-hook>")
  );
}

// Extract a human-readable label for the system message type
function getSystemLabel(content: string): string {
  if (content.includes("<task-notification>")) return "Task Notification";
  if (content.includes("Stop hook feedback:") || content.includes("Stop:Callback hook")) return "Hook Feedback";
  if (content.includes("<system-reminder>")) return "System Reminder";
  if (content.includes("<user-prompt-submit-hook>")) return "Hook";
  return "System";
}

// System message bubble with expand/collapse
function SystemBubble({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const label = getSystemLabel(content);

  // Clean up content for display: strip XML tags for readability
  const cleanContent = content
    .replace(/<\/?system-reminder>/g, "")
    .replace(/<\/?task-notification>/g, "")
    .replace(/<\/?[a-z-]+>/g, "")
    .trim();

  return (
    <div className="chat-bubble chat-bubble-system" onClick={() => setExpanded(!expanded)}>
      <div className="chat-bubble-avatar">⚙️</div>
      <div className="chat-bubble-content">
        <div className="chat-system-label">
          {label}
          <span className="chat-system-toggle">{expanded ? "▼" : "▶"}</span>
        </div>
        {expanded && (
          <div className="chat-system-detail">{cleanContent}</div>
        )}
      </div>
    </div>
  );
}

// Render text with clickable file paths
function TextWithFileLinks({ text, onFileOpen }: { text: string; onFileOpen?: (path: string, name: string) => void }) {
  if (!onFileOpen) return <>{text}</>;

  // Match absolute file paths
  const pathRegex = /(\/[\w.\-\/]+\.\w+)/g;
  const parts: (string | { path: string; name: string })[] = [];
  let lastIndex = 0;
  let match;

  while ((match = pathRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const fullPath = match[1];
    const name = fullPath.split("/").pop() || fullPath;
    parts.push({ path: fullPath, name });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  if (parts.length <= 1 && typeof parts[0] === "string") return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <span key={i}>{part}</span>
        ) : (
          <span
            key={i}
            className="chat-file-link"
            onClick={(e) => { e.stopPropagation(); onFileOpen(part.path, part.name); }}
            title={`${part.path} を開く`}
          >
            📄 {part.name}
          </span>
        )
      )}
    </>
  );
}

export default function ChatView({ terminalId, sessionId, workspacePath, droppedImagePath, onDroppedImageHandled, stagedText, onStagedTextHandled, onSendMessage, onFileOpen, visible = true }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingMessages, setPendingMessages] = useState<PendingMsg[]>([]);
  const [inputText, setInputText] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [sendStatus, setSendStatus] = useState("");
  const [attachedImage, setAttachedImage] = useState<{ dataUrl: string; base64: string; name: string } | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<FileSearchResult[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMessages = useCallback(async () => {
    if (!sessionId) return;
    try {
      const msgs = await invoke<ChatMessage[]>("read_session_messages", {
        sessionId,
      });
      setMessages((prev) => {
        // Only update if message count changed to avoid unnecessary re-renders
        if (prev.length === msgs.length) return prev;
        return msgs;
      });
      if (msgs.length > 0) {
        setPendingMessages([]);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [sessionId]);

  // Initial load + polling (only when visible)
  useEffect(() => {
    if (!visible) return;
    loadMessages();
    pollRef.current = setInterval(loadMessages, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages, visible]);

  // Auto-scroll to bottom only when user is near the bottom
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const threshold = 80;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    const newCount = messages.length + pendingMessages.length;
    if (newCount > prevMessageCountRef.current && isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCountRef.current = newCount;
  }, [messages.length, pendingMessages.length]);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Handle staged text (from skill click etc.)
  useEffect(() => {
    if (!stagedText) return;
    setInputText((prev) => prev ? prev + " " + stagedText : stagedText);
    onStagedTextHandled?.();
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [stagedText, onStagedTextHandled]);

  // Handle image dropped from system (Finder/Desktop)
  useEffect(() => {
    if (!droppedImagePath) return;
    (async () => {
      try {
        const [b64, mime] = await invoke<[string, string]>("read_image_file", { path: droppedImagePath });
        const dataUrl = `data:${mime};base64,${b64}`;
        const name = droppedImagePath.split("/").pop() || "screenshot.png";
        setAttachedImage({ dataUrl, base64: b64, name });
        inputRef.current?.focus();
      } catch (err) {
        console.error("Failed to read dropped image:", err);
      }
      onDroppedImageHandled?.();
    })();
  }, [droppedImagePath, onDroppedImageHandled]);

  // --- Image handling ---

  const processImageFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      // Extract base64 data (remove data:image/...;base64, prefix)
      const base64 = dataUrl.split(",")[1];
      const ext = file.type.split("/")[1] || "png";
      const name = `screenshot-${Date.now()}.${ext}`;
      setAttachedImage({ dataUrl, base64, name });
    };
    reader.readAsDataURL(file);
  }, []);

  // Global paste handler for images when chat is active (captures before xterm)
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const file = item.getAsFile();
          if (file) processImageFile(file);
          inputRef.current?.focus();
          return;
        }
      }
    };
    document.addEventListener("paste", handleGlobalPaste, true);
    return () => document.removeEventListener("paste", handleGlobalPaste, true);
  }, [processImageFile]);

  // Handle paste event (Cmd+V / Ctrl+V)
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) processImageFile(file);
          return;
        }
      }
    },
    [processImageFile]
  );

  // Handle drag & drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      // Check for skill data (from Skills panel drag)
      const skillName = e.dataTransfer?.getData("application/x-claude-skill");
      if (skillName) {
        setInputText((prev) => prev + `/${skillName} `);
        inputRef.current?.focus();
        return;
      }

      // Check for claude-file data (from FileTree drag)
      const fileData = e.dataTransfer?.getData("application/x-claude-file");
      if (fileData) {
        try {
          const parsed = JSON.parse(fileData);
          setAttachedFiles((prev) => [...prev, parsed.path]);
          inputRef.current?.focus();
          return;
        } catch {}
      }

      // Check for plain text (file path)
      const text = e.dataTransfer?.getData("text/plain");
      if (text && text.startsWith("/") && !text.includes("\n")) {
        setAttachedFiles((prev) => [...prev, text]);
        inputRef.current?.focus();
        return;
      }

      // Check for image files
      const files = e.dataTransfer?.files;
      if (files) {
        for (const file of files) {
          if (file.type.startsWith("image/")) {
            processImageFile(file);
            return;
          }
        }
      }
    },
    [processImageFile]
  );

  // Handle file input change
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && file.type.startsWith("image/")) {
        processImageFile(file);
      }
    },
    [processImageFile]
  );

  const removeAttachedImage = useCallback(() => {
    setAttachedImage(null);
  }, []);

  // --- Send logic ---

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text && !attachedImage) return;

    let imagePath: string | undefined;
    let imageDataUrl: string | undefined;

    // If there's an attached image, save it to temp
    if (attachedImage) {
      try {
        imagePath = await invoke<string>("save_temp_image", {
          base64Data: attachedImage.base64,
          filename: attachedImage.name,
        });
        imageDataUrl = attachedImage.dataUrl;
      } catch (err) {
        console.error("Failed to save image:", err);
        setSendStatus("画像の保存に失敗しました");
        setTimeout(() => setSendStatus(""), 3000);
        return;
      }
    }

    // Show message immediately (optimistic)
    setPendingMessages((prev) => [...prev, { text: text || "[画像を送信]", imagePath, imageDataUrl }]);
    setSendStatus("送信中...");

    // Build the message to send to PTY
    let messageToSend = "";

    // Add attached files context
    const allFiles = [...attachedFiles];
    if (allFiles.length > 0) {
      messageToSend += allFiles.map((f) => `@${f}`).join(" ") + " ";
    }

    if (imagePath) {
      messageToSend += `この画像を確認してください: ${imagePath}`;
      if (text) {
        messageToSend += `\n${text}`;
      }
    } else if (text) {
      messageToSend += text;
    }

    onSendMessage(messageToSend.trim());
    setInputText("");
    setAttachedImage(null);
    setAttachedFiles([]);

    setTimeout(() => setSendStatus(""), 2000);
    setTimeout(() => inputRef.current?.focus(), 50);

    // If no session yet, trigger session detection in parent
    if (!sessionId) {
      // Retry loading messages after delays to pick up new session
      setTimeout(loadMessages, 2000);
      setTimeout(loadMessages, 5000);
      setTimeout(loadMessages, 8000);
    } else {
      setTimeout(loadMessages, 1000);
      setTimeout(loadMessages, 3000);
    }
  }, [inputText, attachedImage, attachedFiles, onSendMessage, loadMessages]);

  // Insert @mention file path
  const insertMention = useCallback((file: FileSearchResult) => {
    const el = inputRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart;
    const textBefore = inputText.substring(0, cursorPos);
    const textAfter = inputText.substring(cursorPos);
    const atPos = textBefore.lastIndexOf("@");
    if (atPos === -1) return;

    const newText = textBefore.substring(0, atPos) + file.path + " " + textAfter;
    setInputText(newText);
    setMentionQuery(null);
    setMentionResults([]);
    setTimeout(() => {
      el.focus();
      const newPos = atPos + file.path.length + 1;
      el.setSelectionRange(newPos, newPos);
    }, 50);
  }, [inputText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // @mention navigation
      if (mentionQuery !== null && mentionResults.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((prev) => Math.min(prev + 1, mentionResults.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(mentionResults[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          setMentionQuery(null);
          setMentionResults([]);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, mentionQuery, mentionResults, mentionIndex, insertMention]
  );

  // Auto-resize textarea + @mention detection
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputText(value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    // Detect @mention
    const cursorPos = el.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);

    if (atMatch && workspacePath) {
      const query = atMatch[1];
      setMentionQuery(query);
      setMentionIndex(0);

      // Debounce search
      if (mentionTimerRef.current) clearTimeout(mentionTimerRef.current);
      mentionTimerRef.current = setTimeout(async () => {
        try {
          const results = await invoke<FileSearchResult[]>("search_workspace_files", {
            workspace: workspacePath,
            query: query || "",
          });
          setMentionResults(results);
        } catch {
          setMentionResults([]);
        }
      }, 150);
    } else {
      setMentionQuery(null);
      setMentionResults([]);
    }
  }, [workspacePath]);

  // Remove attached file
  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Filter messages based on toggles
  const filteredMessages = messages.filter((msg) => {
    if (msg.msg_type === "thinking" && !showThinking) return false;
    if ((msg.msg_type === "tool_use" || msg.msg_type === "tool_result") && !showTools) return false;
    return true;
  });

  return (
    <div
      className={`chat-view ${isDragOver ? "chat-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Chat header with toggles */}
      <div className="chat-header">
        <span className="chat-header-title">Chat</span>
        <div className="chat-toggles">
          <label className="chat-toggle">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
            />
            <span>思考</span>
          </label>
          <label className="chat-toggle">
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => setShowTools(e.target.checked)}
            />
            <span>ツール</span>
          </label>
          <button className="chat-refresh" onClick={loadMessages} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="chat-drag-overlay">
          <div className="chat-drag-overlay-content">
            <span className="chat-drag-icon">📎</span>
            <span>画像をドロップして添付</span>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="chat-messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {filteredMessages.length === 0 && pendingMessages.length === 0 && (
          <div className="chat-empty-inline">
            {!sessionId ? (
              <>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>💬</div>
                <div>メッセージを送信してセッションを開始</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                  入力するとClaude Codeに直接送信されます
                </div>
              </>
            ) : (
              "メッセージを送信してください"
            )}
          </div>
        )}
        {filteredMessages.map((msg, i) => (
          <div
            key={`msg-${i}`}
            className={`chat-msg chat-msg-${msg.role} chat-msg-type-${msg.msg_type}`}
          >
            {msg.role === "user" && isSystemMessage(msg.content) && (
              <SystemBubble content={msg.content} />
            )}

            {msg.role === "user" && !isSystemMessage(msg.content) && (
              <div className="chat-bubble chat-bubble-user">
                <div className="chat-bubble-content">
                  <TextWithFileLinks text={msg.content} onFileOpen={onFileOpen} />
                </div>
              </div>
            )}

            {msg.role === "assistant" && msg.msg_type === "text" && (
              <div className="chat-bubble chat-bubble-assistant">
                <div className="chat-bubble-avatar">✦</div>
                <div className="chat-bubble-content chat-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // Make file paths in code blocks clickable
                      code: ({ children, className }) => {
                        const text = String(children).trim();
                        if (!className && text.startsWith("/") && text.includes(".") && !text.includes("\n")) {
                          const name = text.split("/").pop() || text;
                          return (
                            <code
                              className="chat-file-link"
                              onClick={() => onFileOpen?.(text, name)}
                              title={`${text} を開く`}
                            >
                              📄 {name}
                            </code>
                          );
                        }
                        return <code className={className}>{children}</code>;
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {msg.role === "assistant" && msg.msg_type === "thinking" && (
              <div className="chat-bubble chat-bubble-thinking">
                <div className="chat-bubble-avatar">🧠</div>
                <div className="chat-bubble-content">
                  <div className="chat-thinking-label">思考中...</div>
                  <div className="chat-thinking-text">{msg.thinking}</div>
                </div>
              </div>
            )}

            {msg.msg_type === "tool_use" && (
              <div className="chat-bubble chat-bubble-tool">
                <div className="chat-bubble-avatar">🔧</div>
                <div className="chat-bubble-content">
                  <div className="chat-tool-name">{msg.tool_name}</div>
                  <div className="chat-tool-input">{msg.content}</div>
                </div>
              </div>
            )}

            {msg.msg_type === "tool_result" && (
              <div className="chat-bubble chat-bubble-tool-result">
                <div className="chat-bubble-avatar">📋</div>
                <div className="chat-bubble-content">
                  <div className="chat-tool-result">{msg.content}</div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Pending messages (optimistic) */}
        {pendingMessages.map((pm, i) => (
          <div key={`pending-${i}`} className="chat-msg chat-msg-user">
            <div className="chat-bubble chat-bubble-user chat-bubble-pending">
              {pm.imageDataUrl && (
                <div className="chat-image-preview-bubble">
                  <img src={pm.imageDataUrl} alt="attached" />
                </div>
              )}
              <div className="chat-bubble-content">{pm.text}</div>
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* @mention dropdown */}
      {mentionQuery !== null && mentionResults.length > 0 && (
        <div className="mention-dropdown">
          {mentionResults.map((file, i) => (
            <div
              key={file.path}
              className={`mention-item ${i === mentionIndex ? "mention-item-active" : ""}`}
              onClick={() => insertMention(file)}
              onMouseEnter={() => setMentionIndex(i)}
            >
              <span className="mention-icon">{file.is_dir ? "📁" : "📄"}</span>
              <span className="mention-name">{file.name}</span>
              <span className="mention-path">{file.path.split("/").slice(-2, -1)[0]}/</span>
            </div>
          ))}
        </div>
      )}

      {/* Attached files chips */}
      {attachedFiles.length > 0 && (
        <div className="chat-attached-files">
          {attachedFiles.map((f, i) => (
            <div key={i} className="attached-file-chip">
              <span className="attached-file-icon">📄</span>
              <span className="attached-file-name">{f.split("/").pop()}</span>
              <button className="attached-file-remove" onClick={() => removeAttachedFile(i)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Image preview */}
      {attachedImage && (
        <div className="chat-attached-preview">
          <img src={attachedImage.dataUrl} alt="preview" />
          <button className="chat-attached-remove" onClick={removeAttachedImage}>
            ✕
          </button>
          <span className="chat-attached-name">{attachedImage.name}</span>
        </div>
      )}

      {/* Input area */}
      <div className="chat-input-area">
        <button
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          title="画像を添付"
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />
        <textarea
          ref={inputRef}
          className="chat-input"
          value={inputText}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="メッセージを入力... (@でファイル参照, Cmd+Vで画像)"
          rows={1}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!inputText.trim() && !attachedImage && attachedFiles.length === 0}
        >
          ↑
        </button>
      </div>
      {sendStatus && (
        <div className="chat-status">{sendStatus}</div>
      )}
    </div>
  );
}
