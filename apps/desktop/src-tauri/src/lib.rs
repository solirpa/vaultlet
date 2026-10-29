//! Vaultlet desktop backend.

pub mod autolock;
pub mod browser;
pub mod commands;
pub mod icons;
#[cfg(debug_assertions)]
mod debuglog;
pub mod secrets;
pub mod settings;
pub mod state;
pub mod store;
mod titlebar;

use std::path::PathBuf;
use std::time::Instant;

use tauri::{Manager, Runtime};
use tokio::sync::{broadcast, Mutex};

use crate::secrets::Secrets;
use crate::settings::Settings;
use crate::state::{AppState, Paths, SyncStatus};

/// Resolve config/data directories. `VAULTLET_CONFIG_DIR` / `VAULTLET_DATA_DIR` override the
/// platform defaults (used by tests and for running several profiles side by side).
fn resolve_paths<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<Paths> {
    let config_dir = match std::env::var_os("VAULTLET_CONFIG_DIR") {
        Some(p) => PathBuf::from(p),
        None => app.path().app_config_dir()?,
    };
    let data_dir = match std::env::var_os("VAULTLET_DATA_DIR") {
        Some(p) => PathBuf::from(p),
        None => app.path().app_data_dir()?,
    };
    Ok(Paths { config_dir, data_dir })
}

/// Configure a Tauri builder with Vaultlet's plugins, state, background tasks and commands.
pub fn configure<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(|webview, payload| debuglog::on_page_load(&webview, payload));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = resolve_paths(app)?;
            std::fs::create_dir_all(&paths.config_dir)?;
            std::fs::create_dir_all(&paths.data_dir)?;
            let settings = Settings::load(&paths.config_dir);
            let secrets = Secrets::new(&paths.config_dir);
            let app_secret = browser::ipc::load_or_create_secret(&secrets);
            let paired = AppState::load_paired(&paths.config_dir.join("paired.json"));
            let data_dir_for_icons = paths.data_dir.clone();
            let (push, _) = broadcast::channel(32);
            let mode = settings.vault.mode;
            app.manage(AppState {
                paths,
                settings: Mutex::new(settings),
                vault: Mutex::new(None),
                sync: Mutex::new(SyncStatus::idle(mode)),
                webdav_sync: Mutex::new(()),
                paired: Mutex::new(paired),
                pairing: Mutex::new(Default::default()),
                app_secret,
                last_activity: Mutex::new(Instant::now()),
                push,
                secrets,
                watcher: Mutex::new(None),
                icons: icons::IconService::new(&data_dir_for_icons),
                last_import: Mutex::new(None),
            });
            let handle = app.handle().clone();
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    titlebar::log_traffic_lights(&w2);
                });
            }
            browser::ipc::spawn(handle.clone());
            autolock::spawn(handle.clone());
            store::spawn_periodic(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(debug_assertions)]
            debuglog::debug_log,
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_change_password,
            commands::items_list,
            commands::item_get,
            commands::item_save,
            commands::item_delete,
            commands::item_restore,
            commands::item_purge,
            commands::item_touch,
            commands::totp_now,
            commands::password_generate,
            commands::folders_list,
            commands::folder_save,
            commands::folder_delete,
            commands::import_preview,
            commands::import_run,
            commands::import_delete_file,
            commands::settings_get,
            commands::settings_set,
            commands::cloud_folders_detect,
            commands::webdav_set_password,
            commands::webdav_test,
            commands::sync_now,
            commands::sync_status,
            commands::browser_integration_apply,
            commands::paired_browsers_list,
            commands::paired_browser_remove,
            commands::pairing_respond,
            commands::icon_get,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("vaultlet=info".parse().unwrap()))
        .init();

    let mut builder = tauri::Builder::default();
    // A second copy would fail to claim the browser IPC socket and silently leave the extension
    // talking to the first one, so hand over to the running window instead. Separate profiles
    // (`VAULTLET_CONFIG_DIR`) may still run side by side.
    if std::env::var_os("VAULTLET_CONFIG_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            commands::focus_main_window(app);
        }));
    }
    configure(builder)
        .run(tauri::generate_context!())
        .expect("error while running Vaultlet");
}

#[cfg(test)]
mod e2e;
