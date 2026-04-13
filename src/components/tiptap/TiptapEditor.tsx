import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Markdown } from "tiptap-markdown";
import { extensions } from "./extensions";
import { FloatingToolbar } from "./FloatingToolbar";
import "./TiptapEditor.css";

interface TiptapEditorProps {
  content: string;
  filePath: string;
  onChange?: (content: string) => void;
  onSave?: (content: string) => void;
}

export default function TiptapEditor({
  content,
  filePath,
  onChange,
  onSave,
}: TiptapEditorProps) {
  const fileName = filePath.split("/").pop() || "";
  const isInternalUpdate = useRef(false);

  const editor = useEditor({
    extensions: [
      ...extensions,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      isInternalUpdate.current = true;
      const markdown = editor.storage.markdown.getMarkdown();
      onChange?.(markdown);
    },
    editorProps: {
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          if (editor) {
            const markdown = editor.storage.markdown.getMarkdown();
            onSave?.(markdown);
          }
          return true;
        }
        return false;
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    const currentMarkdown = editor.storage.markdown.getMarkdown();
    if (content !== currentMarkdown) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  return (
    <div className="tiptap-preview">
      <div className="tiptap-toolbar">
        <span className="tiptap-toolbar-file">
          <span className="tiptap-toolbar-icon">📄</span>
          {fileName}
        </span>
      </div>
      <div className="tiptap-body">
        {editor && <FloatingToolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
