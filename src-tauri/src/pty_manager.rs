use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        id: String,
        app_handle: AppHandle,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Platform-specific shell
        #[cfg(unix)]
        let mut cmd = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let mut c = CommandBuilder::new(&shell);
            c.arg("-l"); // Login shell
            c
        };

        #[cfg(windows)]
        let mut cmd = {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        };

        if let Some(dir) = cwd {
            cmd.cwd(dir);
        } else if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }

        // Set environment variables
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        #[cfg(unix)]
        {
            cmd.env("LANG", "ja_JP.UTF-8");
            if let Ok(path) = std::env::var("PATH") {
                cmd.env("PATH", path);
            }
            if let Ok(home) = std::env::var("HOME") {
                cmd.env("HOME", home);
            }
        }

        #[cfg(windows)]
        {
            // Pass through essential Windows env vars
            for var in &["PATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "HOMEDRIVE", "HOMEPATH"] {
                if let Ok(val) = std::env::var(var) {
                    cmd.env(var, val);
                }
            }
        }

        let _child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

        // Get reader for output
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        // Get writer for input
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        // Store session
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                id.clone(),
                PtySession {
                    master: pair.master,
                    writer,
                },
            );
        }

        // Spawn reader thread
        let session_id = id.clone();
        let sessions_ref = self.sessions.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Convert to string, replacing invalid UTF-8
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_handle.emit(
                            &format!("pty-output-{}", session_id),
                            PtyOutput {
                                id: session_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            // Clean up on exit
            let mut sessions = sessions_ref.lock().unwrap();
            sessions.remove(&session_id);
            let _ = app_handle.emit(
                &format!("pty-exit-{}", session_id),
                session_id.clone(),
            );
        });

        Ok(())
    }

    pub fn write_to_session(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write: {}", e))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("Failed to flush: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session not found: {}", id))
        }
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get(id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Failed to resize: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session not found: {}", id))
        }
    }

    pub fn close_session(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(id);
        Ok(())
    }
}
