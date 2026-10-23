//! Debug builds only: forward the webview's console errors and unhandled exceptions to the
//! terminal so UI failures are visible without opening devtools.

use tauri::webview::PageLoadEvent;
use tauri::Runtime;

#[tauri::command]
pub fn debug_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "webview", "{message}"),
        "warn" => tracing::warn!(target: "webview", "{message}"),
        _ => tracing::info!(target: "webview", "{message}"),
    }
}

const INIT: &str = r#"
(function () {
  function send(level, args) {
    try {
      var msg = Array.prototype.map.call(args, function (a) {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      }).join(' ');
      window.__TAURI_INTERNALS__.invoke('debug_log', { level: level, message: msg });
    } catch (e) {}
  }
  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () { send(level, arguments); return orig.apply(console, arguments); };
  });
  window.addEventListener('error', function (e) {
    send('error', ['uncaught: ' + e.message + ' @ ' + e.filename + ':' + e.lineno]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    send('error', ['unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason.message || JSON.stringify(e.reason)))]);
  });
  window.addEventListener('DOMContentLoaded', function () { send('info', ['DOMContentLoaded ' + location.href]); });
})();
"#;

/// Install the console forwarder as soon as each page starts loading.
pub fn on_page_load<R: Runtime>(webview: &tauri::Webview<R>, payload: &tauri::webview::PageLoadPayload<'_>) {
    if payload.event() == PageLoadEvent::Started {
        let _ = webview.eval(INIT);
    }
}
