import AuthenticationServices
import Combine
import Foundation

/// Runs blocking work from the Rust core (Argon2, network, file coordination) off the main thread.
func offMain<T>(_ work: @escaping () throws -> T) async throws -> T {
    try await Task.detached(priority: .userInitiated) { try work() }.value
}

/// The open vault and everything around it, shared by the app's screens and the AutoFill
/// extension (each process has its own instance).
///
/// The encrypted vault is cached in the app group, so unlocking works offline; every change is
/// written to the cache first and then synced in the background: to the WebDAV server, or merged
/// into the .kdbx file the user picked in the Files app. Sync state (ETag, unsent changes)
/// survives restarts through `Prefs`.
@MainActor
final class VaultStore: ObservableObject {
    enum State {
        case notConfigured
        case locked
        case unlocked(Vault)
    }

    enum SyncStatus: Equatable {
        case idle
        case syncing
        case failed(String)
    }

    let prefs = Prefs()
    /// The AutoFill extension works from the cache only: it has no access to the picked file
    /// and should not spend its short life on the network.
    let canSync: Bool
    /// Whether to publish logins to the system credential store (QuickType suggestions).
    let publishesIdentities: Bool
    private let cache: URL

    @Published private(set) var state: State
    @Published private(set) var sync: SyncStatus = .idle
    /// Bumped whenever the items may have changed (edit, sync, unlock).
    @Published private(set) var revision = 0

    private var syncing = false
    private var syncRequested = false

    init(canSync: Bool = true, publishesIdentities: Bool = true) {
        self.canSync = canSync
        self.publishesIdentities = publishesIdentities
        let dir = Prefs.cacheDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        cache = dir.appendingPathComponent("vault.kdbx")
        state = prefs.source == nil ? .notConfigured : .locked
    }

    var vault: Vault? {
        if case let .unlocked(v) = state { return v }
        return nil
    }

    var isUnlocked: Bool { vault != nil }

    // MARK: - Setup

    /// First run with WebDAV: download the vault and open it with the master password.
    func setUpWebDav(_ config: WebDavConfig, masterPassword: String) async throws {
        let download = try await offMain { try webdavFetch(config: config) }
        let vault = try await offMain { try openVault(bytes: download.bytes, password: masterPassword) }
        try writeCache(download.bytes)
        try prefs.setWebdav(config)
        prefs.etag = download.etag
        prefs.pendingUpload = false
        vault.setSyncState(etag: download.etag, pendingUpload: false)
        opened(vault)
    }

    /// First run with a file from the Files app (iCloud Drive and the like).
    func setUpFile(_ url: URL, masterPassword: String) async throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let bytes = try await offMain { try VaultFile.read(url) }
        let vault = try await offMain { try openVault(bytes: bytes, password: masterPassword) }
        let bookmark = try url.bookmarkData()
        try writeCache(bytes)
        prefs.source = .file(bookmark: bookmark, name: url.lastPathComponent)
        prefs.etag = nil
        prefs.pendingUpload = false
        opened(vault)
    }

    // MARK: - Lock / unlock

    /// Unlock from the local cache (offline), or fetch the vault first if there is none yet.
    func unlock(masterPassword: String) async throws {
        guard let source = prefs.source else { throw VaultError.Failed(code: "not-configured", detail: "no vault configured") }
        let bytes: Data
        if let cached = try? Data(contentsOf: cache) {
            bytes = cached
        } else {
            // The AutoFill extension only has the cache the app wrote into the app group.
            guard canSync else { throw VaultError.Failed(code: "open-app-first", detail: "no cached vault") }
            switch source {
            case .webdav:
                guard let config = prefs.webdav else { throw VaultError.Failed(code: "not-configured", detail: "no vault configured") }
                let download = try await offMain { try webdavFetch(config: config) }
                prefs.etag = download.etag
                bytes = download.bytes
            case let .file(bookmark, _):
                bytes = try await offMain { try VaultFile.read(bookmark: bookmark) }
            }
            try writeCache(bytes)
        }
        let etag = prefs.etag
        let pending = prefs.pendingUpload
        let vault = try await offMain { try openVault(bytes: bytes, password: masterPassword) }
        vault.setSyncState(etag: etag, pendingUpload: pending)
        opened(vault)
        syncInBackground()
    }

    private func opened(_ vault: Vault) {
        state = .unlocked(vault)
        revision += 1
        if publishesIdentities { CredentialIdentities.publish(from: vault) }
    }

    /// Drops the decrypted vault (the Rust object is freed with the last Swift reference).
    func lock() {
        guard isUnlocked else { return }
        state = .locked
    }

    /// Forget the vault on this device; the server copy / the file is untouched.
    func signOut() {
        lock()
        try? FileManager.default.removeItem(at: cache)
        prefs.clear()
        if publishesIdentities { CredentialIdentities.removeAll() }
        state = .notConfigured
    }

    // MARK: - Edits

    func saveItem(_ input: ItemInput) async throws -> String {
        try await change { try $0.saveItem(input: input) }
    }

    func trashItem(_ id: String) async throws {
        try await change { try $0.trashItem(id: id) }
    }

    private func change<T>(_ edit: @escaping (Vault) throws -> T) async throws -> T {
        guard let vault else { throw VaultError.Failed(code: "locked", detail: "the vault is locked") }
        let (out, bytes) = try await offMain { () -> (T, Data) in
            let out = try edit(vault)
            return (out, try vault.serialize())
        }
        prefs.pendingUpload = true
        try writeCache(bytes)
        revision += 1
        if publishesIdentities { CredentialIdentities.publish(from: vault) }
        syncInBackground()
        return out
    }

    // MARK: - Sync

    func syncInBackground() {
        Task { await syncNow() }
    }

    /// Pull and push (WebDAV) or merge with the file on disk. The vault stays usable meanwhile:
    /// the Rust core only locks it to snapshot and merge, never while waiting on the network.
    func syncNow() async {
        guard canSync, let vault, let source = prefs.source else { return }
        if syncing {
            syncRequested = true
            return
        }
        syncing = true
        sync = .syncing
        do {
            switch source {
            case .webdav:
                guard let config = prefs.webdav else { throw VaultError.Failed(code: "not-configured", detail: "no vault configured") }
                let r = try await offMain { try vault.syncWebdav(config: config) }
                if self.vault === vault { // not locked meanwhile
                    try writeCache(r.vaultBytes)
                    prefs.etag = r.etag
                    prefs.pendingUpload = r.pendingUpload
                    if r.changedLocally { revision += 1 }
                }
            case let .file(bookmark, _):
                let r = try await offMain { try VaultFile.sync(vault, bookmark: bookmark) }
                if self.vault === vault {
                    if let refreshed = r.refreshedBookmark { prefs.updateFileBookmark(refreshed) }
                    if let bytes = r.cacheBytes { try writeCache(bytes) }
                    prefs.pendingUpload = vault.pendingUpload()
                    if r.changedLocally { revision += 1 }
                }
            }
            if self.vault === vault && publishesIdentities { CredentialIdentities.publish(from: vault) }
            sync = .idle
        } catch {
            prefs.pendingUpload = vault.pendingUpload()
            sync = .failed(error.vaultMessage)
        }
        syncing = false
        if syncRequested {
            syncRequested = false
            await syncNow()
        }
    }

    private func writeCache(_ bytes: Data) throws {
        // Readable after the first unlock of the device, so a sync finishing while the screen
        // is locked can still land. The vault stays encrypted with the master password anyway.
        try bytes.write(to: cache, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        // The copy on the server / in iCloud Drive is the one to keep; don't duplicate it into backups.
        var url = cache
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}

/// The .kdbx the user picked in the Files app: coordinated reads and writes through its
/// security-scoped bookmark, so iCloud Drive and other providers see every change.
enum VaultFile {
    struct SyncOutcome {
        var changedLocally: Bool
        /// Bytes to keep as the local cache when the vault changed.
        var cacheBytes: Data?
        var refreshedBookmark: Data?
    }

    static func read(_ url: URL) throws -> Data {
        var coordinationError: NSError?
        var result: Result<Data, Error> = .failure(CocoaError(.fileReadUnknown))
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { u in
            result = Result { try Data(contentsOf: u) }
        }
        if let coordinationError { throw coordinationError }
        return try result.get()
    }

    static func write(_ data: Data, to url: URL) throws {
        var coordinationError: NSError?
        var result: Result<Void, Error> = .success(())
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { u in
            result = Result { try data.write(to: u, options: .atomic) }
        }
        if let coordinationError { throw coordinationError }
        try result.get()
    }

    /// The file's URL, plus a fresh bookmark when iOS says the stored one went stale.
    static func resolve(_ bookmark: Data) throws -> (url: URL, refreshed: Data?) {
        var stale = false
        let url = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        let refreshed = stale ? try? url.bookmarkData() : nil
        return (url, refreshed)
    }

    static func read(bookmark: Data) throws -> Data {
        let (url, _) = try resolve(bookmark)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try read(url)
    }

    /// Merge the file on disk into the open vault and, when the vault has changes the file
    /// lacks, write it back (atomically, through the file coordinator).
    static func sync(_ vault: Vault, bookmark: Data) throws -> SyncOutcome {
        let (url, refreshed) = try resolve(bookmark)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let onDisk = try read(url)
        let merged = try vault.mergeFile(bytes: onDisk)
        var outcome = SyncOutcome(changedLocally: merged.changedLocally, cacheBytes: nil, refreshedBookmark: refreshed)
        if merged.pendingUpload {
            let bytes = try vault.serialize()
            // Edits made while the write is in flight set the flag again.
            vault.markUploaded()
            do {
                try write(bytes, to: url)
            } catch {
                vault.setSyncState(etag: nil, pendingUpload: true)
                throw error
            }
            outcome.cacheBytes = bytes
        } else if merged.changedLocally {
            outcome.cacheBytes = try vault.serialize()
        }
        return outcome
    }
}

/// Logins in the system credential store, so Safari and apps suggest them in the QuickType
/// bar; the AutoFill extension gets the record id back and looks the password up itself.
enum CredentialIdentities {
    static func publish(from vault: Vault) {
        let logins = vault.loginIdentities()
        let store = ASCredentialIdentityStore.shared
        store.getState { state in
            guard state.isEnabled else { return }
            var identities: [any ASCredentialIdentity] = []
            for login in logins {
                for raw in login.urls {
                    guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
                          let host = url.host, !host.isEmpty else { continue }
                    let service = ASCredentialServiceIdentifier(identifier: host, type: .domain)
                    identities.append(ASPasswordCredentialIdentity(serviceIdentifier: service, user: login.username, recordIdentifier: login.id))
                }
            }
            store.replaceCredentialIdentities(identities) { _, _ in }
        }
    }

    static func removeAll() {
        ASCredentialIdentityStore.shared.removeAllCredentialIdentities { _, _ in }
    }
}

extension Error {
    /// Short user-facing text for errors from the Rust core and the keychain.
    var vaultMessage: String {
        if let e = self as? VaultError {
            switch e {
            case let .Failed(code, detail):
                switch code {
                case "invalid-key": return L("err_wrong_password")
                case "webdav-auth": return L("err_webdav_auth")
                case "not-found": return L("err_not_found")
                case "open-app-first": return L("open_app_first_body")
                default: return detail
                }
            }
        }
        if let k = self as? Keychain.Failure {
            switch k {
            case .cancelled: return ""
            case .notFound: return L("biometric_invalidated")
            case .authFailed: return L("biometric_failed")
            case let .status(s): return "Keychain error \(s)"
            }
        }
        return localizedDescription
    }
}

/// Localized string by key (`Shared/Resources/*.lproj/Localizable.strings`).
func L(_ key: String) -> String {
    NSLocalizedString(key, comment: "")
}

func L(_ key: String, _ args: CVarArg...) -> String {
    String(format: NSLocalizedString(key, comment: ""), arguments: args)
}
