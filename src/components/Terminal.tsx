import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

const DARK_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#6a9955",
  yellow: "#d7ba7d",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f44747",
  brightGreen: "#6a9955",
  brightYellow: "#d7ba7d",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#4ec9b0",
  brightWhite: "#ffffff",
};

const LIGHT_THEME = {
  background: "#faf8f5",
  foreground: "#37352f",
  cursor: "#37352f",
  cursorAccent: "#faf8f5",
  selectionBackground: "#d7d3cc",
  black: "#37352f",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#d97706",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f3efe9",
  brightBlack: "#787570",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#faf8f5",
};

interface TerminalProps {
  id: string;
  cwd?: string;
  autoCommand?: string;
  onFileClick?: (filePath: string) => void;
  theme?: "dark" | "light";
}

export default function Terminal({ id, cwd, autoCommand, onFileClick, theme = "dark" }: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const termRef = useRef<XTerminal | null>(null);

  // Update theme when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme === "light" ? LIGHT_THEME : DARK_THEME;
    }
  }, [theme]);

  useEffect(() => {
    if (!wrapperRef.current || !xtermRef.current || initialized.current) return;

    const timer = setTimeout(() => {
      if (!wrapperRef.current || !xtermRef.current || initialized.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      if (rect.height < 50) return;
      initialized.current = true;

      const container = xtermRef.current;
      let term: XTerminal | null = null;
      let fitAddon: FitAddon | null = null;
      let unlistenOutput: UnlistenFn | null = null;
      let unlistenExit: UnlistenFn | null = null;
      let resizeObserver: ResizeObserver | null = null;

      const setup = async () => {
        const currentTheme = theme === "light" ? LIGHT_THEME : DARK_THEME;
        term = new XTerminal({
          cursorBlink: true,
          cursorStyle: "bar",
          fontSize: 14,
          fontFamily: "'SF Mono', 'Menlo', monospace",
          lineHeight: 1.4,
          scrollback: 5000,
          theme: currentTheme,
        });
        termRef.current = term;

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        const webLinksAddon = new WebLinksAddon();
        term.loadAddon(webLinksAddon);

        // Custom link provider for file paths
        if (onFileClick) {
          term.registerLinkProvider({
            provideLinks(bufferLineNumber, callback) {
              if (!term) return callback(undefined);
              const line = term.buffer.active.getLine(bufferLineNumber - 1);
              if (!line) return callback(undefined);
              const text = line.translateToString();

              const links: Array<{
                range: { start: { x: number; y: number }; end: { x: number; y: number } };
                text: string;
                activate: () => void;
              }> = [];

              // Match file paths (including unicode chars for Japanese paths)
              const filePathRegex = /(?:^|[\s('"=])((?:\/|\.\/|~\/)[^\s'")\]>]+\.\w+)/g;
              let match;
              while ((match = filePathRegex.exec(text)) !== null) {
                const filePath = match[1];
                const startX = match.index + (match[0].length - match[1].length) + 1;
                links.push({
                  range: {
                    start: { x: startX, y: bufferLineNumber },
                    end: { x: startX + filePath.length, y: bufferLineNumber },
                  },
                  text: filePath,
                  activate: () => {
                    const expanded = filePath.startsWith("~")
                      ? filePath.replace("~", cwd?.split("/").slice(0, 3).join("/") || "/Users")
                      : filePath.startsWith("/")
                        ? filePath
                        : `${cwd || "."}/${filePath}`;
                    onFileClick(expanded);
                  },
                });
              }

              callback(links.length > 0 ? links : undefined);
            },
          });
        }

        term.open(container);
        fitAddon.fit();

        const cols = term.cols || 80;
        const rows = term.rows || 24;

        try {
          await invoke("create_pty", { id, cols, rows, cwd: cwd || null });
        } catch (err) {
          term.writeln(`\x1b[31mError: ${err}\x1b[0m`);
          return;
        }

        unlistenOutput = await listen<{ id: string; data: string }>(
          `pty-output-${id}`,
          (event) => { term?.write(event.payload.data); }
        );

        unlistenExit = await listen<string>(`pty-exit-${id}`, () => {
          term?.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
        });

        term.onData((data) => {
          invoke("write_pty", { id, data }).catch(() => {});
        });

        term.onResize(({ cols, rows }) => {
          invoke("resize_pty", { id, cols, rows }).catch(() => {});
        });

        if (autoCommand) {
          setTimeout(() => {
            invoke("write_pty", { id, data: autoCommand + "\n" }).catch(() => {});
          }, 800);
        }

        let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
        resizeObserver = new ResizeObserver(() => {
          if (resizeTimeout) return;
          resizeTimeout = setTimeout(() => {
            resizeTimeout = null;
            try { fitAddon?.fit(); } catch { /* */ }
          }, 150);
        });
        resizeObserver.observe(container);
      };

      setup();

      return () => {
        unlistenOutput?.();
        unlistenExit?.();
        resizeObserver?.disconnect();
        invoke("close_pty", { id }).catch(() => {});
        if (term) term.dispose();
        termRef.current = null;
      };
    }, 100);

    return () => clearTimeout(timer);
  }, [id, cwd, autoCommand, onFileClick, theme]);

  const bgColor = theme === "light" ? "#faf8f5" : "#1e1e1e";

  return (
    <div
      ref={wrapperRef}
      style={{ width: "100%", height: "100%", background: bgColor, overflow: "hidden" }}
    >
      <div ref={xtermRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
