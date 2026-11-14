use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize)]
struct Connection {
    token: String,
    port: u16,
    host: String,
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home".into());
    PathBuf::from(home).join(".config/pcctl/config.json")
}

#[tauri::command]
fn get_connection() -> Result<Connection, String> {
    let text = fs::read_to_string(config_path()).map_err(|err| format!("config.json: {err}"))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    Ok(Connection {
        token: value["token"].as_str().unwrap_or("").to_string(),
        port: value["port"].as_u64().unwrap_or(8765) as u16,
        host: "127.0.0.1".to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![get_connection])
        .run(tauri::generate_context!())
        .expect("pcctl-desktop startet nicht");
}
