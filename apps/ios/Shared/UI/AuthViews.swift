import SwiftUI
import UniformTypeIdentifiers

/// Setup → unlock → `unlocked`, with the Face ID offer after a password unlock.
struct AuthFlow<Unlocked: View>: View {
    @EnvironmentObject private var store: VaultStore
    /// The AutoFill extension cannot set a vault up (no file picker, no first download).
    var allowSetup = true
    @ViewBuilder let unlocked: (Vault) -> Unlocked
    // Lives here, not in UnlockView: the offer appears after the switch to the unlocked screen.
    @State private var biometricOffer: String?

    var body: some View {
        Group {
            switch store.state {
            case .notConfigured:
                if allowSetup { SetupView() } else { OpenAppFirst() }
            case .locked:
                UnlockView { biometricOffer = $0 }
            case let .unlocked(vault):
                unlocked(vault).id(ObjectIdentifier(vault))
            }
        }
        .alert(L("biometric_enable_title", Biometrics.name ?? ""), isPresented: Binding(get: { biometricOffer != nil }, set: { if !$0 { biometricOffer = nil } })) {
            Button(L("biometric_enable")) {
                if let password = biometricOffer, (try? Keychain.set(Data(password.utf8), .masterPassword, biometric: true)) != nil {
                    store.prefs.biometricEnabled = true
                }
                biometricOffer = nil
            }
            Button(L("not_now"), role: .cancel) { biometricOffer = nil }
        } message: {
            Text(L("biometric_enable_body", Biometrics.name ?? ""))
        }
    }
}

/// Logo and heading above a floating card, quiet actions below (desktop AuthShell).
struct AuthShell<Content: View, Footer: View>: View {
    @Environment(\.palette) private var p
    let title: String
    var subtitle: String? = nil
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                VaultLogo(size: 64).padding(.top, 56)
                Text(title).font(.title2.weight(.semibold)).foregroundStyle(p.text).multilineTextAlignment(.center).padding(.top, 20)
                if let subtitle {
                    Text(subtitle).font(.callout).foregroundStyle(p.muted).multilineTextAlignment(.center).frame(maxWidth: 340).padding(.top, 6)
                }
                VStack(spacing: 16, content: content)
                    .padding(20)
                    .frame(maxWidth: 440)
                    .background(p.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .shadow(color: p.dark ? .clear : p.text.opacity(0.12), radius: 18, y: 8)
                    .padding(.top, 28)
                VStack(spacing: 4, content: footer).frame(maxWidth: 440).padding(.top, 16)
                Spacer(minLength: 32)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(p.bg)
    }
}

struct ErrorText: View {
    @Environment(\.palette) private var p
    let text: String?

    var body: some View {
        if let text, !text.isEmpty {
            Text(text).font(.subheadline).foregroundStyle(p.danger).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Shown in the AutoFill extension before the app has a vault.
struct OpenAppFirst: View {
    @Environment(\.palette) private var p

    var body: some View {
        AuthShell(title: L("open_app_first_title"), subtitle: L("open_app_first_body")) {
            EmptyView()
        } footer: {
            EmptyView()
        }
    }
}

// MARK: - Setup

private enum SetupStep: Equatable {
    case choose
    case file(URL)
    case webdav
}

struct SetupView: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: VaultStore
    @State private var step = SetupStep.choose
    @State private var picking = false
    @State private var error: String?

    var body: some View {
        switch step {
        case .choose:
            AuthShell(title: L("setup_title"), subtitle: L("setup_body")) {
                SourceChoice(icon: "icloud", title: L("setup_file"), detail: L("setup_file_body")) { picking = true }
                SourceChoice(icon: "externaldrive.connected.to.line.below", title: L("setup_webdav"), detail: L("setup_webdav_body")) { step = .webdav }
                ErrorText(text: error)
            } footer: {
                Text(L("setup_footer")).font(.caption).foregroundStyle(p.faint).multilineTextAlignment(.center)
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.data]) { result in
                switch result {
                case let .success(url): step = .file(url)
                case let .failure(e): error = e.localizedDescription
                }
            }
        case let .file(url):
            FileSetupView(url: url) { step = .choose }
        case .webdav:
            WebDavSetupView { step = .choose }
        }
    }
}

private struct SourceChoice: View {
    @Environment(\.palette) private var p
    let icon: String
    let title: String
    let detail: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 22)).foregroundStyle(p.accent).frame(width: 36)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline).foregroundStyle(p.text)
                    Text(detail).font(.subheadline).foregroundStyle(p.muted).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(p.faint)
            }
            .padding(14)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

private struct FileSetupView: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: VaultStore
    let url: URL
    let onBack: () -> Void
    @State private var master = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        AuthShell(title: L("unlock_title"), subtitle: url.lastPathComponent) {
            FilledField(label: L("master_password"), text: $master, secret: true, submitLabel: .go) { open() }
            ErrorText(text: error)
            PrimaryButton(title: L("open"), enabled: !master.isEmpty, busy: busy) { open() }
        } footer: {
            Button(L("choose_another")) { onBack() }.font(.subheadline).foregroundStyle(p.muted).padding(8)
        }
    }

    private func open() {
        guard !busy, !master.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do { try await store.setUpFile(url, masterPassword: master) } catch { self.error = error.vaultMessage }
            busy = false
        }
    }
}

private struct WebDavSetupView: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: VaultStore
    let onBack: () -> Void
    @State private var url = "https://dav.jianguoyun.com/dav/"
    @State private var user = ""
    @State private var appPassword = ""
    @State private var path = "/我的坚果云/Vaultlet/Vaultlet.kdbx"
    @State private var master = ""
    @State private var busy = false
    @State private var error: String?

    private var ready: Bool { !user.trimmingCharacters(in: .whitespaces).isEmpty && !appPassword.isEmpty && !master.isEmpty }

    var body: some View {
        AuthShell(title: L("setup_webdav"), subtitle: L("setup_webdav_hint")) {
            FilledField(label: L("setup_url"), text: $url, keyboard: .URL, submitLabel: .next)
            FilledField(label: L("setup_user"), text: $user, keyboard: .emailAddress, submitLabel: .next)
            VStack(alignment: .leading, spacing: 6) {
                FilledField(label: L("setup_app_password"), text: $appPassword, secret: true, submitLabel: .next)
                Text(L("setup_app_password_hint")).font(.caption).foregroundStyle(p.muted).padding(.leading, 4)
            }
            FilledField(label: L("setup_path"), text: $path, keyboard: .URL, submitLabel: .next)
            FilledField(label: L("master_password"), text: $master, secret: true, submitLabel: .go) { connect() }
            ErrorText(text: error)
            PrimaryButton(title: L("setup_connect"), enabled: ready, busy: busy) { connect() }
        } footer: {
            Button(L("choose_another")) { onBack() }.font(.subheadline).foregroundStyle(p.muted).padding(8)
        }
    }

    private func connect() {
        guard !busy, ready else { return }
        busy = true
        error = nil
        let config = WebDavConfig(url: url.trimmingCharacters(in: .whitespaces), username: user.trimmingCharacters(in: .whitespaces), password: appPassword, remotePath: path.trimmingCharacters(in: .whitespaces))
        Task {
            do { try await store.setUpWebDav(config, masterPassword: master) } catch { self.error = error.vaultMessage }
            busy = false
        }
    }
}

// MARK: - Unlock

struct UnlockView: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: VaultStore
    /// Called with the password after a successful typed unlock, to offer Face ID.
    let onOfferBiometric: (String) -> Void
    @State private var master = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmSignOut = false
    @State private var triedBiometric = false

    private var biometricName: String? { Biometrics.name }
    private var hasBiometric: Bool { biometricName != nil && store.prefs.biometricEnabled }

    var body: some View {
        AuthShell(title: L("unlock_title"), subtitle: store.prefs.source?.displayName) {
            FilledField(label: L("master_password"), text: $master, secret: true, submitLabel: .go) { unlock(master, offerBiometric: true) }
            ErrorText(text: error)
            PrimaryButton(title: L("unlock"), enabled: !master.isEmpty, busy: busy) { unlock(master, offerBiometric: true) }
            if hasBiometric, let name = biometricName {
                TonalButton(title: L("unlock_biometric", name), icon: name == "Touch ID" ? "touchid" : "faceid") { unlockWithBiometric() }
            }
        } footer: {
            Button(L("sign_out")) { confirmSignOut = true }.font(.subheadline).foregroundStyle(p.muted).padding(8)
        }
        .onAppear {
            // Offer Face ID right away when it is set up.
            if hasBiometric && !triedBiometric {
                triedBiometric = true
                unlockWithBiometric()
            }
        }
        .confirmationDialog(L("sign_out_confirm"), isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(L("sign_out"), role: .destructive) { store.signOut() }
            Button(L("cancel"), role: .cancel) {}
        }
    }

    private func unlock(_ password: String, offerBiometric: Bool) {
        guard !busy, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            do {
                try await store.unlock(masterPassword: password)
                if offerBiometric, biometricName != nil, !store.prefs.biometricEnabled { onOfferBiometric(password) }
            } catch {
                self.error = error.vaultMessage
            }
            busy = false
        }
    }

    private func unlockWithBiometric() {
        guard !busy else { return }
        busy = true
        error = nil
        let prompt = L("biometric_title")
        Task {
            do {
                let data = try await offMain { try Keychain.get(.masterPassword, prompt: prompt) }
                guard let password = String(data: data, encoding: .utf8) else { throw Keychain.Failure.notFound }
                try await store.unlock(masterPassword: password)
            } catch let failure as Keychain.Failure {
                switch failure {
                case .cancelled:
                    break
                case .notFound:
                    // Biometrics changed on this device: the stored password is gone for good.
                    store.prefs.biometricEnabled = false
                    Keychain.delete(.masterPassword)
                    error = L("biometric_invalidated")
                case .authFailed:
                    error = L("biometric_failed")
                case .status:
                    error = failure.vaultMessage
                }
            } catch {
                self.error = error.vaultMessage
            }
            busy = false
        }
    }
}
