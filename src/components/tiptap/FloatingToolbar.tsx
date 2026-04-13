import { useState, useCallback } from "react";
import { BubbleMenu, type Editor } from "@tiptap/react";
import "./FloatingToolbar.css";

interface FloatingToolbarProps {
  editor: Editor;
}

export function FloatingToolbar({ editor }: FloatingToolbarProps) {
  const [showBlockMenu, setShowBlockMenu] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const blockTypes = [
    { label: "段落", action: () => editor.chain().focus().setParagraph().run() },
    { label: "見出し1", action: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: "見出し2", action: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "見出し3", action: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "引用", action: () => editor.chain().focus().toggleBlockquote().run() },
    { label: "コード", action: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: "箇条書き", action: () => editor.chain().focus().toggleBulletList().run() },
    { label: "番号リスト", action: () => editor.chain().focus().toggleOrderedList().run() },
  ];

  const getCurrentBlockLabel = (): string => {
    if (editor.isActive("heading", { level: 1 })) return "見出し1";
    if (editor.isActive("heading", { level: 2 })) return "見出し2";
    if (editor.isActive("heading", { level: 3 })) return "見出し3";
    if (editor.isActive("blockquote")) return "引用";
    if (editor.isActive("codeBlock")) return "コード";
    if (editor.isActive("bulletList")) return "箇条書き";
    if (editor.isActive("orderedList")) return "番号リスト";
    return "段落";
  };

  const handleLinkSubmit = useCallback(() => {
    if (linkUrl) {
      editor.chain().focus().setLink({ href: linkUrl }).run();
    } else {
      editor.chain().focus().unsetLink().run();
    }
    setShowLinkInput(false);
    setLinkUrl("");
  }, [editor, linkUrl]);

  const handleLinkKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleLinkSubmit();
      }
      if (e.key === "Escape") {
        setShowLinkInput(false);
        setLinkUrl("");
      }
    },
    [handleLinkSubmit]
  );

  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 150, placement: "top" }}
      shouldShow={({ editor }) => {
        if (editor.isActive("codeBlock")) return false;
        const { from, to } = editor.state.selection;
        return from !== to;
      }}
    >
      <div className="floating-toolbar">
        {showLinkInput ? (
          <div className="floating-toolbar-link-input">
            <input
              type="url"
              placeholder="URLを入力..."
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={handleLinkKeyDown}
              autoFocus
            />
            <button onClick={handleLinkSubmit}>✓</button>
            <button onClick={() => { setShowLinkInput(false); setLinkUrl(""); }}>✕</button>
          </div>
        ) : (
          <>
            <div className="floating-toolbar-block-selector">
              <button
                className="floating-toolbar-block-btn"
                onClick={() => setShowBlockMenu(!showBlockMenu)}
              >
                {getCurrentBlockLabel()} ▾
              </button>
              {showBlockMenu && (
                <div className="floating-toolbar-block-menu">
                  {blockTypes.map((bt) => (
                    <button
                      key={bt.label}
                      className="floating-toolbar-block-item"
                      onClick={() => {
                        bt.action();
                        setShowBlockMenu(false);
                      }}
                    >
                      {bt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="floating-toolbar-divider" />

            <button
              className={`floating-toolbar-btn ${editor.isActive("bold") ? "active" : ""}`}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title="太字 (Cmd+B)"
            >
              B
            </button>
            <button
              className={`floating-toolbar-btn italic ${editor.isActive("italic") ? "active" : ""}`}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title="イタリック (Cmd+I)"
            >
              I
            </button>
            <button
              className={`floating-toolbar-btn strikethrough ${editor.isActive("strike") ? "active" : ""}`}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              title="取り消し線 (Cmd+Shift+S)"
            >
              S
            </button>
            <button
              className={`floating-toolbar-btn code ${editor.isActive("code") ? "active" : ""}`}
              onClick={() => editor.chain().focus().toggleCode().run()}
              title="インラインコード (Cmd+E)"
            >
              &lt;/&gt;
            </button>

            <div className="floating-toolbar-divider" />

            <button
              className={`floating-toolbar-btn ${editor.isActive("link") ? "active" : ""}`}
              onClick={() => {
                if (editor.isActive("link")) {
                  editor.chain().focus().unsetLink().run();
                } else {
                  const previousUrl = editor.getAttributes("link").href || "";
                  setLinkUrl(previousUrl);
                  setShowLinkInput(true);
                }
              }}
              title="リンク (Cmd+K)"
            >
              🔗
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
