import Foundation

/// Where the vault comes from. The decrypted vault never leaves memory; the encrypted file is
/// cached in app storage so unlocking works offline.
enum VaultSource: Equatable {
    /// A WebDAV server (e.g. 坚果云); the app password is in the keychain.
    case webdav(url: String, username: String, remotePath: String)
    /// A .kdbx chosen in the Files app (iCloud Drive, another provider, or on this device),
    /// kept as a security-scoped bookmark.
    case file(bookmark: Data, name: String)

    /// File name shown on the unlock screen.
    var displayName: String {
        switch self {
        case let .webdav(_, _, remotePath): return remotePath.split(separator: "/").last.map(String.init) ?? remotePath
        case let .file(_, name): return name
        }
    }
}

/// What the app remembers about the vault, shared with the AutoFill extension through the app
/// group. Secrets go to the keychain (`Keychain`), never to user defaults.
final class Prefs {
    static let appGroup = "group.com.vaultlet.ios"

    /// Container shared with the AutoFill extension; nil when the app-group entitlement is
    /// missing (unsigned development builds), in which case each process keeps its own copy.
    static var sharedContainer: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    /// Directory of the encrypted vault cache (not under Caches: the system must not purge it).
    static var cacheDirectory: URL {
        if let shared = sharedContainer { return shared.appendingPathComponent("Library/Application Support", isDirectory: true) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    private let d: UserDefaults

    init() {
        d = (Prefs.sharedContainer != nil ? UserDefaults(suiteName: Prefs.appGroup) : nil) ?? .standard
    }

    var source: VaultSource? {
        get {
            switch d.string(forKey: "source_kind") {
            case "webdav":
                guard let url = d.string(forKey: "webdav_url") else { return nil }
                return .webdav(url: url, username: d.string(forKey: "webdav_user") ?? "", remotePath: d.string(forKey: "webdav_path") ?? "")
            case "file":
                guard let bookmark = d.data(forKey: "file_bookmark") else { return nil }
                return .file(bookmark: bookmark, name: d.string(forKey: "file_name") ?? "Vaultlet.kdbx")
            default:
                return nil
            }
        }
        set {
            for key in ["source_kind", "webdav_url", "webdav_user", "webdav_path", "file_bookmark", "file_name"] { d.removeObject(forKey: key) }
            switch newValue {
            case let .webdav(url, username, remotePath):
                d.set("webdav", forKey: "source_kind")
                d.set(url, forKey: "webdav_url")
                d.set(username, forKey: "webdav_user")
                d.set(remotePath, forKey: "webdav_path")
            case let .file(bookmark, name):
                d.set("file", forKey: "source_kind")
                d.set(bookmark, forKey: "file_bookmark")
                d.set(name, forKey: "file_name")
            case nil:
                break
            }
        }
    }

    /// The WebDAV connection with its app password, when that is the source.
    var webdav: WebDavConfig? {
        guard case let .webdav(url, username, remotePath) = source else { return nil }
        let password = (try? Keychain.get(.webdavPassword)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return WebDavConfig(url: url, username: username, password: password, remotePath: remotePath)
    }

    func setWebdav(_ config: WebDavConfig) throws {
        try Keychain.set(Data(config.password.utf8), .webdavPassword)
        source = .webdav(url: config.url, username: config.username, remotePath: config.remotePath)
    }

    /// Refreshed security-scoped bookmark after iOS reported the stored one stale.
    func updateFileBookmark(_ bookmark: Data) {
        guard case let .file(_, name) = source else { return }
        source = .file(bookmark: bookmark, name: name)
    }

    /// ETag of the WebDAV copy the local cache corresponds to.
    var etag: String? {
        get { d.string(forKey: "etag") }
        set { d.set(newValue, forKey: "etag") }
    }

    /// Local changes not on the server / in the file yet.
    var pendingUpload: Bool {
        get { d.bool(forKey: "pending_upload") }
        set { d.set(newValue, forKey: "pending_upload") }
    }

    /// Face ID / Touch ID unlock: the master password is in the keychain behind biometrics.
    var biometricEnabled: Bool {
        get { d.bool(forKey: "biometric") }
        set { d.set(newValue, forKey: "biometric") }
    }

    /// Lock after this many minutes in the background; 0 = never.
    var autoLockMinutes: Int {
        get { d.object(forKey: "auto_lock_minutes") as? Int ?? 5 }
        set { d.set(newValue, forKey: "auto_lock_minutes") }
    }

    func clear() {
        for key in ["source_kind", "webdav_url", "webdav_user", "webdav_path", "file_bookmark", "file_name", "etag", "pending_upload", "biometric", "auto_lock_minutes"] {
            d.removeObject(forKey: key)
        }
        Keychain.delete(.webdavPassword)
        Keychain.delete(.masterPassword)
    }
}
