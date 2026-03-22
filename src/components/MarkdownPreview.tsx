import { useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./MarkdownPreview.css";

interface MarkdownPreviewProps {
  content: string;
  filePath: string;
  onChange?: (content: string) => void;
  onSave?: (content: string) => void;
}

export default function MarkdownPreview({ content, filePath, onChange, onSave }: MarkdownPreviewProps) {
  const fileName = filePath.split("/").pop() || "";
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync when content changes externally
  useEffect(() => {
    if (!isEditing) setEditContent(content);
  }, [content, isEditing]);

  const startEditing = useCallback(() => {
    setEditContent(content);
    setIsEditing(true);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  }, [content]);

  const stopEditing = useCallback(() => {
    setIsEditing(false);
    if (editContent !== content) {
      onChange?.(editContent);
    }
  }, [editContent, content, onChange]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setEditContent(e.target.value);
      onChange?.(e.target.value);
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave?.(editContent);
      }
      if (e.key === "Escape") {
        stopEditing();
      }
    },
    [editContent, onSave, stopEditing]
  );

  return (
    <div className="md-preview">
      {/* Header with file info and edit toggle */}
      <div className="md-toolbar">
        <span className="md-toolbar-file">
          <span className="md-toolbar-icon">📄</span>
          {fileName}
        </span>
        <div className="md-toolbar-actions">
          {isEditing && (
            <span className="md-toolbar-hint">Esc で戻る · Cmd+S で保存</span>
          )}
          <button
            className={`md-toolbar-btn ${isEditing ? "active" : ""}`}
            onClick={() => isEditing ? stopEditing() : startEditing()}
          >
            {isEditing ? "👁 プレビュー" : "✏️ 編集"}
          </button>
        </div>
      </div>

      {isEditing ? (
        /* Raw markdown editor - full screen textarea */
        <div className="md-edit-body">
          <textarea
            ref={textareaRef}
            className="md-edit-textarea"
            value={editContent}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
        </div>
      ) : (
        /* Rendered preview - click to edit */
        <div className="md-preview-body" onDoubleClick={startEditing}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1 className="md-h1">{children}</h1>,
              h2: ({ children }) => <h2 className="md-h2">{children}</h2>,
              h3: ({ children }) => <h3 className="md-h3">{children}</h3>,
              h4: ({ children }) => <h4 className="md-h4">{children}</h4>,
              p: ({ children }) => <p className="md-p">{children}</p>,
              ul: ({ children }) => <ul className="md-ul">{children}</ul>,
              ol: ({ children }) => <ol className="md-ol">{children}</ol>,
              li: ({ children }) => <li className="md-li">{children}</li>,
              blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
              code: ({ className, children, ...props }) => {
                const isInline = !className;
                if (isInline) {
                  return <code className="md-code-inline">{children}</code>;
                }
                return (
                  <div className="md-code-block">
                    <div className="md-code-header">
                      {className?.replace("language-", "") || "code"}
                    </div>
                    <pre className="md-pre">
                      <code className={className} {...props}>{children}</code>
                    </pre>
                  </div>
                );
              },
              table: ({ children }) => (
                <div className="md-table-wrapper">
                  <table className="md-table">{children}</table>
                </div>
              ),
              th: ({ children }) => <th className="md-th">{children}</th>,
              td: ({ children }) => <td className="md-td">{children}</td>,
              a: ({ href, children }) => (
                <a className="md-link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>
              ),
              hr: () => <hr className="md-hr" />,
              img: ({ src, alt }) => (
                <div className="md-img-wrapper">
                  <img className="md-img" src={src} alt={alt || ""} />
                  {alt && <span className="md-img-caption">{alt}</span>}
                </div>
              ),
              input: ({ checked, ...props }) => (
                <input
                  className="md-checkbox"
                  type="checkbox"
                  checked={checked}
                  readOnly
                  {...props}
                />
              ),
            }}
          >
            {content}
          </ReactMarkdown>
          <div className="md-edit-hint">ダブルクリックで編集</div>
        </div>
      )}
    </div>
  );
}
