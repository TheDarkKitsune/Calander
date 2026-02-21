// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

#[cfg(target_os = "windows")]
fn apply_window_icon(app: &tauri::App) {
  let icon_path = app
    .path_resolver()
    .resolve_resource("icons/icon.ico")
    .or_else(|| {
      let cwd = std::env::current_dir().ok()?;
      let candidates = [
        cwd.join("icons").join("icon.ico"),
        cwd.join("src-tauri").join("icons").join("icon.ico"),
        cwd.join("..").join("icons").join("icon.ico"),
        cwd.join("..").join("src-tauri").join("icons").join("icon.ico"),
      ];
      candidates.into_iter().find(|path| path.exists())
    });

  if let (Some(window), Some(path)) = (app.get_window("main"), icon_path) {
    let _ = window.set_icon(tauri::Icon::File(path));
  }
}

fn main() {
  let builder = tauri::Builder::default();
  let builder = if cfg!(debug_assertions) {
    builder
  } else {
    builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
  };
  let builder = builder.setup(|app| {
    #[cfg(target_os = "windows")]
    apply_window_icon(app);
    Ok(())
  });

  builder
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
