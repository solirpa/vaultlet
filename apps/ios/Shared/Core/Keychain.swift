import Foundation
import LocalAuthentication
import Security

/// Small secrets in the iOS keychain, shared with the AutoFill extension through the app group
/// (an app group id doubles as a keychain access group).
///
/// - `webdavPassword`: readable after the first unlock of the device (background sync).
/// - `masterPassword`: only behind the device's *current* biometrics; adding or removing a
///   face or finger makes the item unreadable, so the user has to type the password once
///   more (same rule as the Android app's keystore key).
enum Keychain {
    enum Account: String {
        case webdavPassword = "webdav-password"
        case masterPassword = "master-password"
    }

    enum Failure: Error {
        case notFound
        case cancelled
        case authFailed
        case status(OSStatus)
    }

    private static let service = "com.vaultlet.ios"

    private static func query(_ account: Account, group: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.rawValue,
        ]
        if group { q[kSecAttrAccessGroup as String] = Prefs.appGroup }
        return q
    }

    /// Runs `op` against the shared access group, or without one when this build has no
    /// app-group entitlement (errSecMissingEntitlement).
    private static func withGroup(_ op: (Bool) -> OSStatus) -> OSStatus {
        let status = op(true)
        return status == errSecMissingEntitlement ? op(false) : status
    }

    static func set(_ value: Data, _ account: Account, biometric: Bool = false) throws {
        let status = withGroup { group in
            SecItemDelete(query(account, group: group) as CFDictionary)
            var q = query(account, group: group)
            q[kSecValueData as String] = value
            if biometric {
                var err: Unmanaged<CFError>?
                guard let control = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &err) else {
                    return errSecParam
                }
                q[kSecAttrAccessControl as String] = control
            } else {
                q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            }
            return SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw failure(status) }
    }

    /// Reads a secret. For a biometric item the system shows Face ID / Touch ID with `prompt`,
    /// so call it off the main thread.
    static func get(_ account: Account, prompt: String? = nil) throws -> Data {
        var found: Data?
        let status = withGroup { group in
            var q = query(account, group: group)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            if let prompt {
                let context = LAContext()
                context.localizedReason = prompt
                q[kSecUseAuthenticationContext as String] = context
            }
            var out: CFTypeRef?
            let s = SecItemCopyMatching(q as CFDictionary, &out)
            found = out as? Data
            return s
        }
        guard status == errSecSuccess, let data = found else { throw failure(status) }
        return data
    }

    static func delete(_ account: Account) {
        _ = withGroup { group in SecItemDelete(query(account, group: group) as CFDictionary) }
    }

    private static func failure(_ status: OSStatus) -> Failure {
        switch status {
        case errSecItemNotFound: return .notFound
        case errSecUserCanceled: return .cancelled
        case errSecAuthFailed: return .authFailed
        default: return .status(status)
        }
    }
}

/// Biometrics on this device, for labels and availability.
enum Biometrics {
    static var available: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }

    /// "Face ID", "Touch ID" or "Optic ID"; nil when none is usable.
    static var name: String? {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return nil
        }
    }
}
