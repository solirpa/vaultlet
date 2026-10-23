//! Auto-lock after a period of inactivity.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::{AppState, PushEvent};

/// Lock the vault and notify the UI and connected browsers.
pub async fn lock<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let had = state.vault.lock().await.take().is_some();
    *state.watcher.lock().await = None;
    if had {
        let _ = app.emit("vault:locked", ());
        state.push(PushEvent::Locked);
    }
}

pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let state = app.state::<AppState>();
            let minutes = state.settings.lock().await.security.auto_lock_minutes;
            if minutes == 0 {
                continue;
            }
            if state.vault.lock().await.is_none() {
                continue;
            }
            let idle = state.last_activity.lock().await.elapsed();
            if idle >= Duration::from_secs(u64::from(minutes) * 60) {
                lock(&app).await;
            }
        }
    });
}
