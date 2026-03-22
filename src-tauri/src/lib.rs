mod pty_manager;

use pty_manager::PtyManager;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use base64::Engine;

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    extension: String,
    size: u64,
}

struct AppState {
    pty_manager: Mutex<PtyManager>,
}

// === File Commands ===

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Error reading entry: {}", e))?;
        let metadata = entry.metadata().map_err(|e| format!("Error reading metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        let ext = entry
            .path()
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();

        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            extension: ext,
            size: metadata.len(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

// === Skills Commands ===

#[derive(Serialize)]
struct SkillInfo {
    name: String,        // command name (filename without .md)
    display_name: String, // human-readable name
    description: String, // first line of content
    path: String,        // full file path
    scope: String,       // "user" | "project"
    content: String,     // full content
}

#[tauri::command]
fn list_skills(workspace: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let mut skills: Vec<SkillInfo> = Vec::new();

    // 1. User-level commands: ~/.claude/commands/
    let user_cmd_dir = home.join(".claude").join("commands");
    if user_cmd_dir.is_dir() {
        read_skills_from_dir(&user_cmd_dir, "command", &mut skills);
    }

    // 2. User-level skills: ~/.claude/skills/*/SKILL.md
    let user_skills_dir = home.join(".claude").join("skills");
    if user_skills_dir.is_dir() {
        read_skill_md_dirs(&user_skills_dir, "skill", &mut skills);
    }

    // 3. Scheduled tasks: ~/.claude/scheduled-tasks/*/SKILL.md
    let sched_dir = home.join(".claude").join("scheduled-tasks");
    if sched_dir.is_dir() {
        read_skill_md_dirs(&sched_dir, "scheduled", &mut skills);
    }

    // 4. Plugin skills: ~/.claude/plugins/marketplaces/*/plugins/*/skills/*/SKILL.md
    let plugins_dir = home.join(".claude").join("plugins").join("marketplaces");
    if plugins_dir.is_dir() {
        if let Ok(marketplaces) = fs::read_dir(&plugins_dir) {
            for mp in marketplaces.flatten() {
                let plugins_sub = mp.path().join("plugins");
                if let Ok(plugins) = fs::read_dir(&plugins_sub) {
                    for plugin in plugins.flatten() {
                        let skills_sub = plugin.path().join("skills");
                        if skills_sub.is_dir() {
                            read_skill_md_dirs(&skills_sub, "plugin", &mut skills);
                        }
                    }
                }
                // external_plugins
                let ext_plugins = mp.path().join("external_plugins");
                if let Ok(plugins) = fs::read_dir(&ext_plugins) {
                    for plugin in plugins.flatten() {
                        let skills_sub = plugin.path().join("skills");
                        if skills_sub.is_dir() {
                            read_skill_md_dirs(&skills_sub, "plugin", &mut skills);
                        }
                    }
                }
            }
        }
    }

    // 5. Project-level commands: <workspace>/.claude/commands/
    if let Some(ws) = &workspace {
        let project_dir = PathBuf::from(ws).join(".claude").join("commands");
        if project_dir.is_dir() {
            read_skills_from_dir(&project_dir, "project", &mut skills);
        }
    }

    Ok(skills)
}

/// Read SKILL.md files from subdirectories (e.g. ~/.claude/skills/my-skill/SKILL.md)
fn read_skill_md_dirs(dir: &PathBuf, scope: &str, skills: &mut Vec<SkillInfo>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let skill_file = path.join("SKILL.md");
        if skill_file.exists() {
            let dir_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if let Some(skill) = parse_skill_file(&skill_file, &dir_name, scope) {
                skills.push(skill);
            }
        }
    }
}

fn read_skills_from_dir(dir: &PathBuf, scope: &str, skills: &mut Vec<SkillInfo>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            // Check subdirectories
            if path.is_dir() {
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub in sub_entries.flatten() {
                        let sub_path = sub.path();
                        let sub_name = sub_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        if sub_name.ends_with(".md") {
                            if let Some(skill) = parse_skill_file(&sub_path, &format!("{}/{}", name, sub_name.trim_end_matches(".md")), scope) {
                                skills.push(skill);
                            }
                        }
                    }
                }
            }
            continue;
        }
        let cmd_name = name.trim_end_matches(".md").to_string();
        if let Some(skill) = parse_skill_file(&path, &cmd_name, scope) {
            skills.push(skill);
        }
    }
}

fn parse_skill_file(path: &PathBuf, cmd_name: &str, scope: &str) -> Option<SkillInfo> {
    let content = fs::read_to_string(path).ok()?;
    let description = content.lines()
        .find(|l| !l.trim().is_empty() && !l.starts_with('#') && !l.starts_with("---"))
        .unwrap_or("")
        .to_string();
    let display_name = cmd_name.replace('-', " ").replace('_', " ");
    // Capitalize first letter
    let display_name = display_name.chars().next()
        .map(|c| c.to_uppercase().to_string() + &display_name[1..])
        .unwrap_or(display_name);

    Some(SkillInfo {
        name: cmd_name.to_string(),
        display_name,
        description: description.chars().take(100).collect(),
        path: path.to_string_lossy().to_string(),
        scope: scope.to_string(),
        content,
    })
}

// === MCP Server Commands ===

#[derive(Serialize)]
struct McpServerInfo {
    name: String,
    command: String,
    args: Vec<String>,
    enabled: bool,
    scope: String, // "user" | "project"
}

#[tauri::command]
fn read_mcp_servers(workspace: Option<String>) -> Result<Vec<McpServerInfo>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let mut servers: Vec<McpServerInfo> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1. User-level: ~/.claude/settings.json
    let user_settings = home.join(".claude").join("settings.json");
    if user_settings.exists() {
        parse_mcp_settings(&user_settings, "user", &mut servers);
        for s in &servers { seen_names.insert(s.name.clone()); }
    }

    // 2. Plugin MCP servers: ~/.claude/plugins/marketplaces/*/external_plugins/*/.mcp.json
    let plugins_base = home.join(".claude").join("plugins").join("marketplaces");
    if plugins_base.is_dir() {
        if let Ok(marketplaces) = fs::read_dir(&plugins_base) {
            for mp in marketplaces.flatten() {
                let ext_dir = mp.path().join("external_plugins");
                if !ext_dir.is_dir() { continue; }
                if let Ok(plugins) = fs::read_dir(&ext_dir) {
                    for plugin in plugins.flatten() {
                        let mcp_file = plugin.path().join(".mcp.json");
                        if mcp_file.exists() {
                            parse_mcp_json_file(&mcp_file, "plugin", &mut servers, &mut seen_names);
                        }
                    }
                }
                // Also check plugins/ dir
                let plugins_dir = mp.path().join("plugins");
                if !plugins_dir.is_dir() { continue; }
                if let Ok(plugins) = fs::read_dir(&plugins_dir) {
                    for plugin in plugins.flatten() {
                        let mcp_file = plugin.path().join(".mcp.json");
                        if mcp_file.exists() {
                            parse_mcp_json_file(&mcp_file, "plugin", &mut servers, &mut seen_names);
                        }
                    }
                }
            }
        }
    }

    // 3. Infer from permissions in settings.local.json
    let local_settings = home.join(".claude").join("settings.local.json");
    if local_settings.exists() {
        infer_mcp_from_permissions(&local_settings, &mut servers, &mut seen_names);
    }

    // 4. Project-level: <workspace>/.claude/settings.json
    if let Some(ws) = &workspace {
        let project_settings = PathBuf::from(ws).join(".claude").join("settings.json");
        if project_settings.exists() {
            parse_mcp_settings(&project_settings, "project", &mut servers);
        }
    }

    Ok(servers)
}

fn parse_mcp_json_file(path: &PathBuf, scope: &str, servers: &mut Vec<McpServerInfo>, seen: &mut std::collections::HashSet<String>) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Handle both { "mcpServers": { ... } } and { "name": { ... } } formats
    let servers_obj = if let Some(mcp) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
        mcp.clone()
    } else if let Some(obj) = parsed.as_object() {
        obj.clone()
    } else {
        return;
    };

    for (name, config) in &servers_obj {
        if name == "mcpServers" { continue; }
        if seen.contains(name) { continue; }
        seen.insert(name.clone());

        let command = config.get("command").and_then(|c| c.as_str())
            .or_else(|| config.get("type").and_then(|c| c.as_str()))
            .unwrap_or("").to_string();
        let args: Vec<String> = config.get("args")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let url = config.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();

        servers.push(McpServerInfo {
            name: name.clone(),
            command: if command.is_empty() { url } else { command },
            args,
            enabled: true,
            scope: scope.to_string(),
        });
    }
}

fn infer_mcp_from_permissions(path: &PathBuf, servers: &mut Vec<McpServerInfo>, seen: &mut std::collections::HashSet<String>) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };
    let perms = match parsed.get("permissions").and_then(|p| p.get("allow")).and_then(|a| a.as_array()) {
        Some(a) => a,
        None => return,
    };
    for perm in perms {
        if let Some(s) = perm.as_str() {
            if s.starts_with("mcp__") {
                let parts: Vec<&str> = s.split("__").collect();
                if parts.len() >= 2 {
                    let name = parts[1].to_string();
                    if !seen.contains(&name) {
                        seen.insert(name.clone());
                        servers.push(McpServerInfo {
                            name,
                            command: "inferred".to_string(),
                            args: Vec::new(),
                            enabled: true,
                            scope: "inferred".to_string(),
                        });
                    }
                }
            }
        }
    }
}

fn parse_mcp_settings(path: &PathBuf, scope: &str, servers: &mut Vec<McpServerInfo>) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(mcp_servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, config) in mcp_servers {
            let command = config.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let args: Vec<String> = config.get("args")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let disabled = config.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false);

            servers.push(McpServerInfo {
                name: name.clone(),
                command,
                args,
                enabled: !disabled,
                scope: scope.to_string(),
            });
        }
    }
}

/// Toggle MCP server enabled/disabled in settings.json
#[tauri::command]
fn toggle_mcp_server(name: String, enabled: bool) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let settings_path = home.join(".claude").join("settings.json");

    let content = fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let mut parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;

    if let Some(servers) = parsed.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        if let Some(server) = servers.get_mut(&name) {
            if let Some(obj) = server.as_object_mut() {
                if enabled {
                    obj.remove("disabled");
                } else {
                    obj.insert("disabled".to_string(), serde_json::Value::Bool(true));
                }
            }
        }
    }

    let output = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&settings_path, output)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

// === Claude Session Commands ===

#[derive(Serialize)]
struct ClaudeSession {
    id: String,
    title: String,
    project: String,
    project_path: String, // decoded real filesystem path for cwd
    modified: u64,        // unix timestamp in seconds
    size: u64,
}

/// Encode a filesystem path the same way Claude CLI does:
/// replace every non-alphanumeric character with '-'
fn encode_path_to_project_name(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Try to resolve the encoded project name back to a real filesystem path
/// by scanning common directories under home.
fn resolve_project_path(project_name: &str, home: &PathBuf) -> String {
    // Quick check: is it just the home directory?
    let home_str = home.to_string_lossy().to_string();
    if encode_path_to_project_name(&home_str) == project_name {
        return home_str;
    }

    // Scan one level under home
    if let Ok(entries) = fs::read_dir(home) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let encoded = encode_path_to_project_name(&p.to_string_lossy());
            if encoded == project_name {
                return p.to_string_lossy().to_string();
            }
            // Scan two levels deep
            if let Ok(sub_entries) = fs::read_dir(&p) {
                for sub in sub_entries.flatten() {
                    let sp = sub.path();
                    if !sp.is_dir() {
                        continue;
                    }
                    let sub_encoded = encode_path_to_project_name(&sp.to_string_lossy());
                    if sub_encoded == project_name {
                        return sp.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    // Fallback to home
    home_str
}

#[tauri::command]
fn list_claude_sessions() -> Result<Vec<ClaudeSession>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut sessions: Vec<ClaudeSession> = Vec::new();

    // Build a cache of project_name -> resolved_path
    let mut project_path_cache: HashMap<String, String> = HashMap::new();

    let project_dirs =
        fs::read_dir(&projects_dir).map_err(|e| format!("Failed to read projects: {}", e))?;

    for project_entry in project_dirs.flatten() {
        if !project_entry.path().is_dir() {
            continue;
        }
        let project_name = project_entry
            .file_name()
            .to_string_lossy()
            .to_string();

        // Skip worktree directories (temporary)
        if project_name.contains("worktrees") {
            continue;
        }

        let entries = match fs::read_dir(project_entry.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            if !name.ends_with(".jsonl") {
                continue;
            }

            let session_id = name.trim_end_matches(".jsonl").to_string();

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let size = metadata.len();

            // Skip very small files (likely not real sessions)
            if size < 100 {
                continue;
            }

            // Extract first user message as title
            let title = extract_session_title(&path).unwrap_or_else(|| "Untitled".to_string());

            // Skip sessions with no meaningful title
            if title == "Untitled" {
                continue;
            }

            // Resolve project path (cached)
            let project_path = project_path_cache
                .entry(project_name.clone())
                .or_insert_with(|| resolve_project_path(&project_name, &home))
                .clone();

            sessions.push(ClaudeSession {
                id: session_id,
                title,
                project: project_name.clone(),
                project_path,
                modified,
                size,
            });
        }
    }

    // Sort by modified time, newest first
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));

    // Limit to most recent 50 sessions
    sessions.truncate(50);

    Ok(sessions)
}

fn extract_session_title(path: &PathBuf) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }

        let content = match parsed.get("message").and_then(|m| m.get("content")) {
            Some(c) => c,
            None => continue,
        };

        let text = if let Some(s) = content.as_str() {
            s.to_string()
        } else if let Some(arr) = content.as_array() {
            arr.iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .next()
                .unwrap_or_default()
        } else {
            continue;
        };

        // Clean up: remove XML-like tags, take first meaningful line
        let cleaned = text
            .lines()
            .find(|l| {
                let trimmed = l.trim();
                !trimmed.is_empty() && !trimmed.starts_with('<')
            })
            .unwrap_or(&text);

        // Truncate to 60 chars
        let title: String = cleaned.chars().take(60).collect();
        if title.is_empty() {
            continue;
        }
        return Some(title);
    }

    None
}

// === Find active session for a project directory ===

/// Find the most recently modified JSONL session file for a given working directory.
/// `after_ts` is a unix timestamp in seconds — only sessions modified after this time are considered.
/// Pass 0 to get any session (backwards compat).
#[tauri::command]
fn find_active_session(cwd: String, after_ts: Option<u64>) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let project_name = encode_path_to_project_name(&cwd);
    let project_dir = home.join(".claude").join("projects").join(&project_name);

    if !project_dir.is_dir() {
        return Err(format!("Project directory not found for {}", cwd));
    }

    let threshold = after_ts
        .filter(|&ts| ts > 0)
        .map(|ts| std::time::UNIX_EPOCH + std::time::Duration::from_secs(ts));

    let mut newest: Option<(String, std::time::SystemTime)> = None;

    if let Ok(entries) = fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    // Skip sessions older than threshold
                    if let Some(thresh) = &threshold {
                        if modified < *thresh {
                            continue;
                        }
                    }
                    let session_id = name.trim_end_matches(".jsonl").to_string();
                    if let Some((_, best_time)) = &newest {
                        if modified > *best_time {
                            newest = Some((session_id, modified));
                        }
                    } else {
                        newest = Some((session_id, modified));
                    }
                }
            }
        }
    }

    newest.map(|(id, _)| id).ok_or_else(|| "No session found".to_string())
}

// === Chat View: Read session messages ===

#[derive(Serialize, Clone)]
struct ChatMessage {
    role: String,         // "user" | "assistant" | "tool_use" | "tool_result"
    content: String,      // text content
    thinking: String,     // thinking content (for assistant)
    tool_name: String,    // tool name (for tool_use)
    timestamp: String,    // ISO timestamp if available
    msg_type: String,     // "text" | "thinking" | "tool_use" | "tool_result" | "image"
}

#[tauri::command]
fn read_session_messages(session_id: String) -> Result<Vec<ChatMessage>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    // Search all project directories for this session ID
    let mut session_path: Option<PathBuf> = None;
    if let Ok(dirs) = fs::read_dir(&projects_dir) {
        for dir_entry in dirs.flatten() {
            let candidate = dir_entry.path().join(format!("{}.jsonl", session_id));
            if candidate.exists() {
                session_path = Some(candidate);
                break;
            }
        }
    }

    let path = session_path.ok_or_else(|| format!("Session {} not found", session_id))?;
    let file = fs::File::open(&path).map_err(|e| format!("Failed to open: {}", e))?;
    let reader = BufReader::new(file);

    let mut messages: Vec<ChatMessage> = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = parsed.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if msg_type == "user" {
            let content = parsed.get("message").and_then(|m| m.get("content"));
            if let Some(content) = content {
                let text = extract_text_from_content(content);
                let has_image = content.as_array().map_or(false, |arr| {
                    arr.iter().any(|item| item.get("type").and_then(|t| t.as_str()) == Some("image"))
                });
                if !text.is_empty() || has_image {
                    let is_image_only = has_image && text.is_empty();
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: if is_image_only { "[画像]".to_string() } else { text },
                        thinking: String::new(),
                        tool_name: String::new(),
                        timestamp: timestamp.clone(),
                        msg_type: if is_image_only { "image".to_string() } else { "text".to_string() },
                    });
                }
            }
        } else if msg_type == "" || msg_type == "assistant" {
            // Assistant messages (type field may be absent)
            let role = parsed.get("message").and_then(|m| m.get("role")).and_then(|r| r.as_str()).unwrap_or("");
            if role != "assistant" {
                continue;
            }

            let content = match parsed.get("message").and_then(|m| m.get("content")) {
                Some(c) => c,
                None => continue,
            };

            if let Some(arr) = content.as_array() {
                for item in arr {
                    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match item_type {
                        "text" => {
                            let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
                            if !text.is_empty() {
                                messages.push(ChatMessage {
                                    role: "assistant".to_string(),
                                    content: text.to_string(),
                                    thinking: String::new(),
                                    tool_name: String::new(),
                                    timestamp: timestamp.clone(),
                                    msg_type: "text".to_string(),
                                });
                            }
                        }
                        "thinking" => {
                            let thinking = item.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                            if !thinking.is_empty() {
                                // Only include first 200 chars of thinking
                                let short: String = thinking.chars().take(200).collect();
                                messages.push(ChatMessage {
                                    role: "assistant".to_string(),
                                    content: String::new(),
                                    thinking: short,
                                    tool_name: String::new(),
                                    timestamp: timestamp.clone(),
                                    msg_type: "thinking".to_string(),
                                });
                            }
                        }
                        "tool_use" => {
                            let tool_name = item.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                            let input_str = item.get("input")
                                .map(|i| {
                                    let s = i.to_string();
                                    let truncated: String = s.chars().take(150).collect();
                                    if truncated.len() < s.len() { format!("{}...", truncated) } else { s }
                                })
                                .unwrap_or_default();
                            messages.push(ChatMessage {
                                role: "assistant".to_string(),
                                content: input_str,
                                thinking: String::new(),
                                tool_name: tool_name.to_string(),
                                timestamp: timestamp.clone(),
                                msg_type: "tool_use".to_string(),
                            });
                        }
                        "tool_result" => {
                            let result_content = item.get("content").and_then(|c| c.as_str()).unwrap_or("");
                            let short: String = result_content.chars().take(200).collect();
                            messages.push(ChatMessage {
                                role: "tool".to_string(),
                                content: short,
                                thinking: String::new(),
                                tool_name: String::new(),
                                timestamp: timestamp.clone(),
                                msg_type: "tool_result".to_string(),
                            });
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(messages)
}

fn extract_text_from_content(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let texts: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect();
        return texts.join("\n");
    }
    String::new()
}

// === File Search Command (for @mention) ===

#[derive(Serialize)]
struct FileSearchResult {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn search_workspace_files(workspace: String, query: String) -> Result<Vec<FileSearchResult>, String> {
    let mut results: Vec<FileSearchResult> = Vec::new();
    let query_lower = query.to_lowercase();
    search_recursive(&PathBuf::from(&workspace), &query_lower, &mut results, 0, 4);
    results.truncate(20);
    Ok(results)
}

fn search_recursive(dir: &PathBuf, query: &str, results: &mut Vec<FileSearchResult>, depth: usize, max_depth: usize) {
    if depth > max_depth || results.len() >= 20 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "__pycache__" {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if name.to_lowercase().contains(query) {
            results.push(FileSearchResult {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                is_dir,
            });
        }
        if is_dir && results.len() < 20 {
            search_recursive(&path, query, results, depth + 1, max_depth);
        }
    }
}

// === Image Commands ===

/// Read an image file and return base64-encoded data + mime type
#[tauri::command]
fn read_image_file(path: String) -> Result<(String, String), String> {
    let path = PathBuf::from(&path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let data = fs::read(&path).map_err(|e| format!("Failed to read image: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok((b64, mime.to_string()))
}

#[tauri::command]
fn save_temp_image(base64_data: String, filename: String) -> Result<String, String> {
    let tmp_dir = std::env::temp_dir().join("claude-workspace-images");
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    let path = tmp_dir.join(&filename);
    fs::write(&path, &data).map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

// === PTY Commands ===

#[tauri::command]
fn create_pty(
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.create_session(id, app_handle, cols, rows, cwd)
}

#[tauri::command]
fn write_pty(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.write_to_session(&id, &data)
}

#[tauri::command]
fn resize_pty(id: String, cols: u16, rows: u16, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.resize_session(&id, cols, rows)
}

#[tauri::command]
fn close_pty(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().unwrap();
    manager.close_session(&id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            pty_manager: Mutex::new(PtyManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            list_directory,
            get_home_dir,
            list_skills,
            read_mcp_servers,
            toggle_mcp_server,
            list_claude_sessions,
            read_session_messages,
            find_active_session,
            search_workspace_files,
            read_image_file,
            save_temp_image,
            create_pty,
            write_pty,
            resize_pty,
            close_pty,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
