import { useRef, useCallback, useEffect, useState } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

interface MonacoEditorProps {
  filePath: string;
  content: string;
  language: string;
  onSave?: (content: string) => void;
  onChange?: (content: string) => void;
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    md: "markdown",
    markdown: "markdown",
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    py: "python",
    rs: "rust",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    txt: "plaintext",
  };
  return map[ext] || "plaintext";
}

export default function MonacoEditor({
  filePath,
  content,
  language,
  onSave,
  onChange,
}: MonacoEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [modified, setModified] = useState(false);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Warm Light Theme
      monaco.editor.defineTheme("warm-light", {
        base: "vs",
        inherit: true,
        rules: [
          { token: "comment", foreground: "9ca0a6", fontStyle: "italic" },
          { token: "keyword", foreground: "9854f1" },
          { token: "string", foreground: "4d7c0f" },
          { token: "number", foreground: "d97706" },
          { token: "type", foreground: "0891b2" },
          { token: "function", foreground: "2563eb" },
          { token: "variable", foreground: "37352f" },
          { token: "constant", foreground: "d97706" },
          { token: "tag", foreground: "dc2626" },
          { token: "attribute.name", foreground: "9854f1" },
          { token: "attribute.value", foreground: "4d7c0f" },
          { token: "keyword.md", foreground: "2563eb", fontStyle: "bold" },
          { token: "string.link.md", foreground: "0891b2" },
          { token: "variable.md", foreground: "9854f1" },
          { token: "markup.bold", foreground: "d97706", fontStyle: "bold" },
          { token: "markup.italic", foreground: "9854f1", fontStyle: "italic" },
        ],
        colors: {
          "editor.background": "#faf8f5",
          "editor.foreground": "#37352f",
          "editor.lineHighlightBackground": "#f3efe9",
          "editor.selectionBackground": "#d7d3cc",
          "editor.inactiveSelectionBackground": "#e8e4de",
          "editorLineNumber.foreground": "#b0ada8",
          "editorLineNumber.activeForeground": "#787570",
          "editorCursor.foreground": "#37352f",
          "editor.selectionHighlightBackground": "#e8e4de",
          "editorIndentGuide.background": "#e8e4de",
          "editorIndentGuide.activeBackground": "#d7d3cc",
          "editorWidget.background": "#f3efe9",
          "editorWidget.border": "#e8e4de",
          "editorSuggestWidget.background": "#f3efe9",
          "editorSuggestWidget.border": "#e8e4de",
          "editorSuggestWidget.selectedBackground": "#e8e4de",
          "scrollbarSlider.background": "#d7d3cc80",
          "scrollbarSlider.hoverBackground": "#b0ada880",
        },
      });
      monaco.editor.setTheme("warm-light");

      // Cmd+S save
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const value = editor.getValue();
        onSave?.(value);
        setModified(false);
      });

      if (language === "markdown") {
        editor.updateOptions({ wordWrap: "on" });
      }

      editor.focus();
    },
    [language, onSave]
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        setModified(true);
        onChange?.(value);
      }
    },
    [onChange]
  );

  useEffect(() => {
    setModified(false);
  }, [filePath]);

  return (
    <div style={{ height: "100%", position: "relative" }}>
      {modified && (
        <div
          style={{
            position: "absolute",
            top: 4,
            right: 16,
            zIndex: 10,
            fontSize: 11,
            color: "#d97706",
            background: "#fef9ee",
            padding: "2px 8px",
            borderRadius: 4,
            border: "1px solid #e8e4de",
            fontWeight: 500,
          }}
        >
          unsaved - Cmd+S to save
        </div>
      )}
      <Editor
        height="100%"
        language={language}
        value={content}
        onMount={handleMount}
        onChange={handleChange}
        options={{
          fontSize: 14,
          fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
          lineHeight: 22,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          padding: { top: 12 },
          renderLineHighlight: "gutter",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          bracketPairColorization: { enabled: true },
          guides: { indentation: true },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
        }}
        loading={
          <div className="placeholder">
            <div className="placeholder-text">Loading editor...</div>
          </div>
        }
      />
    </div>
  );
}
