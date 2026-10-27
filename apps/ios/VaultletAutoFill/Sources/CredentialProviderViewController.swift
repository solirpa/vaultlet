import AuthenticationServices
import SwiftUI
import UIKit

/// Password AutoFill in Safari and other apps (Settings → Passwords → Password Options →
/// AutoFill from Vaultlet). Runs in its own process with its own `VaultStore`, working from
/// the vault cache in the app group; it unlocks with Face ID / Touch ID or the master password.
final class CredentialProviderViewController: ASCredentialProviderViewController {
    private let store = VaultStore(canSync: false, publishesIdentities: false)
    private var host: UIHostingController<AnyView>?

    /// The user tapped the key icon / "Vaultlet" in the QuickType bar: unlock if needed, then
    /// pick a login. Those matching the site come first; any login can be chosen.
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        show(services: serviceIdentifiers, wanted: nil)
    }

    /// A QuickType suggestion was tapped. The vault is locked in this fresh process, so ask the
    /// system for the UI (`prepareInterfaceToProvideCredential`).
    override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
        cancel(.userInteractionRequired)
    }

    override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
        let identity = credentialRequest.credentialIdentity
        show(services: [identity.serviceIdentifier], wanted: identity.recordIdentifier)
    }

    private func show(services: [ASCredentialServiceIdentifier], wanted: String?) {
        let onPick: (ItemDetail) -> Void = { [weak self] detail in self?.complete(with: detail) }
        let onCancel: () -> Void = { [weak self] in self?.cancel(.userCanceled) }
        let root = Themed {
            AutoFillPicker(services: services, wanted: wanted, onPick: onPick, onCancel: onCancel)
        }
        .environmentObject(store)
        if let host {
            host.rootView = AnyView(root)
            return
        }
        let controller = UIHostingController(rootView: AnyView(root))
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: view.topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        controller.didMove(toParent: self)
        host = controller
    }

    private func complete(with detail: ItemDetail) {
        store.vault?.touch(id: detail.id)
        extensionContext.completeRequest(withSelectedCredential: ASPasswordCredential(user: detail.username, password: detail.password), completionHandler: nil)
    }

    private func cancel(_ code: ASExtensionError.Code) {
        extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
    }
}
