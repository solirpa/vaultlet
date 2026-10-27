import Foundation
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

enum Clipboard {
    /// Copy to the clipboard. Secrets stay on this device (no Universal Clipboard) and expire
    /// after 30 seconds.
    static func copy(_ text: String, secret: Bool) {
        #if canImport(UIKit)
        var options: [UIPasteboard.OptionsKey: Any] = [:]
        if secret {
            options[.localOnly] = true
            options[.expirationDate] = Date(timeIntervalSinceNow: 30)
        }
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: text]], options: options)
        #endif
    }
}
