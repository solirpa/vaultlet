//! macOS title bar geometry: logs where AppKit actually put the traffic lights so the web
//! toolbar can be aligned to them.

#[cfg(target_os = "macos")]
pub fn log_traffic_lights<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    let w = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let Ok(ptr) = w.ns_window() else { return };
        let ns: &NSWindow = &*(ptr as *const NSWindow);
        let frame = ns.frame();
        let win_h = frame.size.height;
        for (name, kind) in [("close", NSWindowButton::CloseButton), ("min", NSWindowButton::MiniaturizeButton), ("zoom", NSWindowButton::ZoomButton)] {
            if let Some(b) = ns.standardWindowButton(kind) {
                let r = b.frame();
                // Convert to window coordinates, then to "distance from the window's top".
                let sup = b.superview();
                let abs = match &sup {
                    Some(s) => s.convertRect_toView(r, None),
                    None => r,
                };
                let top = win_h - (abs.origin.y + abs.size.height);
                tracing::info!(
                    target: "titlebar",
                    "{name}: x={:.1} top={:.1} w={:.1} h={:.1} center_y={:.1} (window h={:.1})",
                    abs.origin.x, top, abs.size.width, abs.size.height, top + abs.size.height / 2.0, win_h
                );
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn log_traffic_lights<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
