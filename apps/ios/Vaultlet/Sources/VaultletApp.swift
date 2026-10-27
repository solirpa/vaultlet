import SwiftUI

@main
struct VaultletApp: App {
    @StateObject private var store = VaultStore()
    @Environment(\.scenePhase) private var phase
    @State private var backgroundSince: Date?

    var body: some Scene {
        WindowGroup {
            Themed {
                RootView()
            }
            .environmentObject(store)
            .onChange(of: phase) { _, newPhase in
                switch newPhase {
                case .background:
                    backgroundSince = Date()
                    if store.prefs.autoLockMinutes == 0 { store.lock() }
                case .active:
                    if let since = backgroundSince {
                        backgroundSince = nil
                        let minutes = store.prefs.autoLockMinutes
                        if minutes > 0, Date().timeIntervalSince(since) >= Double(minutes) * 60 {
                            store.lock()
                        } else {
                            // Back from another app or the Files app: pick up outside changes.
                            store.syncInBackground()
                        }
                    }
                default:
                    break
                }
            }
        }
    }
}

struct RootView: View {
    @Environment(\.palette) private var p
    @Environment(\.scenePhase) private var phase
    @EnvironmentObject private var store: VaultStore

    var body: some View {
        AuthFlow { vault in
            VaultView(vault: vault)
        }
        .overlay {
            // Keep secrets out of the app switcher snapshot.
            if phase != .active && store.isUnlocked {
                ZStack {
                    p.bg.ignoresSafeArea()
                    VaultLogo(size: 72)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: phase == .active)
    }
}
