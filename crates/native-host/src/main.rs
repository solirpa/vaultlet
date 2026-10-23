//! Native messaging host for Vaultlet.
//!
//! The browser launches this binary and talks to it over stdin/stdout using
//! Chrome's native messaging framing. We forward every frame verbatim to the
//! desktop app over a local socket and relay the answers back. No business
//! logic lives here; if the app is not running we answer with
//! `{ "error": "app-not-running" }` so the extension can show a helpful hint.

use interprocess::local_socket::tokio::{prelude::*, Stream};
use serde_json::json;
use tokio::io::{stdin, stdout, AsyncWriteExt};
use vault_ipc::{read_frame, socket_name, write_frame, write_json};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut stdin = stdin();
    let mut stdout = stdout();

    // Connect lazily: we only need the app once the browser sends something.
    let mut app: Option<Stream> = None;

    loop {
        let frame = match read_frame(&mut stdin).await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(_) => break,
        };

        if app.is_none() {
            match connect_app().await {
                Ok(s) => app = Some(s),
                Err(_) => {
                    let _ = write_json(&mut stdout, &json!({ "error": "app-not-running" })).await;
                    continue;
                }
            }
        }

        // Forward to the app; stream its replies until the app closes.
        let mut stream = app.take().unwrap();
        if write_frame(&mut stream, &frame).await.is_err() {
            let _ = write_json(&mut stdout, &json!({ "error": "app-not-running" })).await;
            continue;
        }

        // Pump both directions concurrently until stdin closes.
        let (mut rx, mut tx) = stream.split();
        let mut stdin_closed = false;
        loop {
            tokio::select! {
                inbound = read_frame(&mut stdin) => {
                    match inbound {
                        Ok(Some(f)) => {
                            if write_frame(&mut tx, &f).await.is_err() { break; }
                        }
                        _ => { stdin_closed = true; break; }
                    }
                }
                outbound = read_frame(&mut rx) => {
                    match outbound {
                        Ok(Some(f)) => {
                            if write_frame(&mut stdout, &f).await.is_err() { stdin_closed = true; break; }
                        }
                        _ => break, // app went away; reconnect on next inbound frame
                    }
                }
            }
        }
        if stdin_closed {
            break;
        }
        // The app went away: tell the extension and exit so that the browser
        // starts a fresh host (and therefore a fresh handshake) on reconnect.
        let _ = write_json(&mut stdout, &json!({ "error": "app-disconnected" })).await;
        break;
    }
    let _ = stdout.flush().await;
}

async fn connect_app() -> std::io::Result<Stream> {
    let name = socket_name()?;
    Stream::connect(name).await
}
