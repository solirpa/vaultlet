import SwiftUI

/// Target of the editor sheet: a new login, or an existing one.
struct EditTarget: Identifiable {
    let itemId: String?
    var id: String { itemId ?? "new" }
}

/// The unlocked vault: list → detail as a stack on iPhone, side by side on iPad (and in
/// wide iPhone / Split View layouts), where the detail column shows the selected item.
struct VaultView: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @EnvironmentObject private var store: VaultStore
    @StateObject private var toaster = Toaster()
    let vault: Vault
    @State private var selection: String?
    @State private var path: [String] = []
    @State private var editing: EditTarget?

    var body: some View {
        Group {
            if sizeClass == .regular {
                NavigationSplitView {
                    ItemListView(vault: vault, selection: $selection, onNew: { editing = EditTarget(itemId: nil) })
                        .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
                } detail: {
                    if let id = selection {
                        ItemDetailView(vault: vault, id: id, onEdit: { editing = EditTarget(itemId: id) }, onGone: { selection = nil })
                    } else {
                        NoSelection()
                    }
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                NavigationStack(path: $path) {
                    ItemListView(vault: vault, selection: .constant(nil), onNew: { editing = EditTarget(itemId: nil) })
                        .navigationDestination(for: String.self) { id in
                            ItemDetailView(vault: vault, id: id, onEdit: { editing = EditTarget(itemId: id) }, onGone: { path = [] })
                        }
                }
            }
        }
        .environmentObject(toaster)
        .toastOverlay()
        .sheet(item: $editing) { target in
            EditView(vault: vault, id: target.itemId, onSaved: { id in
                editing = nil
                toaster.show(L("saved"))
                show(id)
            }, onTrashed: {
                editing = nil
                toaster.show(L("trashed"))
                selection = nil
                path = []
            })
            .environmentObject(store)
            .environmentObject(toaster)
            .interactiveDismissDisabled()
        }
    }

    private func show(_ id: String) {
        if sizeClass == .regular { selection = id } else { path = [id] }
    }
}

private struct NoSelection: View {
    @Environment(\.palette) private var p

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(p.surface3).frame(width: 64, height: 64)
                Image(systemName: "key").font(.system(size: 28)).foregroundStyle(p.faint)
            }
            Text(L("no_selection")).font(.callout).foregroundStyle(p.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(p.bg)
    }
}

// MARK: - List

struct ItemListView: View {
    @Environment(\.palette) private var p
    @EnvironmentObject private var store: VaultStore
    let vault: Vault
    @Binding var selection: String?
    let onNew: () -> Void
    @State private var query = ""
    @State private var items: [ItemSummary] = []
    @State private var confirmSignOut = false

    private var favorites: [ItemSummary] { query.isEmpty ? items.filter(\.favorite) : [] }

    var body: some View {
        List(selection: $selection) {
            Section {
                SyncLine(status: store.sync)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 8, trailing: 4))
                    .listRowSeparator(.hidden)
            }
            if items.isEmpty {
                Section {
                    EmptyState(text: L(query.isEmpty ? "empty_vault" : "no_results"))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            } else {
                if !favorites.isEmpty {
                    Section {
                        ForEach(favorites) { item in row(item) }
                    } header: {
                        SectionHeader(text: L("favorites"), count: favorites.count)
                    }
                }
                Section {
                    ForEach(items) { item in row(item) }
                } header: {
                    SectionHeader(text: L(query.isEmpty ? "all_items" : "results"), count: items.count)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(p.bg)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("search"))
        .navigationTitle(vault.name())
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { store.lock() } label: { Image(systemName: "lock") }.accessibilityLabel(L("lock"))
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button { store.syncInBackground() } label: { Label(L("sync_now"), systemImage: "arrow.triangle.2.circlepath") }
                    if store.prefs.biometricEnabled, let name = Biometrics.name {
                        Button {
                            store.prefs.biometricEnabled = false
                            Keychain.delete(.masterPassword)
                        } label: { Label(L("biometric_off", name), systemImage: name == "Touch ID" ? "touchid" : "faceid") }
                    }
                    Picker(L("auto_lock"), selection: Binding(get: { store.prefs.autoLockMinutes }, set: { store.prefs.autoLockMinutes = $0 })) {
                        Text(L("auto_lock_immediately")).tag(0)
                        Text(L("auto_lock_minutes", 1)).tag(1)
                        Text(L("auto_lock_minutes", 5)).tag(5)
                        Text(L("auto_lock_minutes", 15)).tag(15)
                        Text(L("auto_lock_minutes", 60)).tag(60)
                        Text(L("auto_lock_never")).tag(-1)
                    }
                    .pickerStyle(.menu)
                    Divider()
                    Button(role: .destructive) { confirmSignOut = true } label: { Label(L("sign_out"), systemImage: "rectangle.portrait.and.arrow.right") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(L("more"))
                Button(action: onNew) { Image(systemName: "plus") }.accessibilityLabel(L("new_login"))
            }
        }
        .confirmationDialog(L("sign_out_confirm"), isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(L("sign_out"), role: .destructive) { store.signOut() }
            Button(L("cancel"), role: .cancel) {}
        }
        .task(id: "\(query)\u{0}\(store.revision)") {
            let q = query
            let result = q.isEmpty ? vault.items() : vault.search(query: q)
            if !Task.isCancelled { items = result }
        }
    }

    private func row(_ item: ItemSummary) -> some View {
        NavigationLink(value: item.id) { ItemRow(item: item) }
            .surfaceRow(p)
            .listRowInsets(EdgeInsets(top: 9, leading: 14, bottom: 9, trailing: 14))
    }
}

extension ItemSummary: Identifiable {}

struct SectionHeader: View {
    @Environment(\.palette) private var p
    let text: String
    var count: Int? = nil

    var body: some View {
        HStack {
            Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(p.muted)
            Spacer()
            if let count { Text("\(count)").font(.caption).foregroundStyle(p.faint) }
        }
        .textCase(nil)
    }
}

struct SyncLine: View {
    @Environment(\.palette) private var p
    let status: VaultStore.SyncStatus

    var body: some View {
        HStack(spacing: 6) {
            switch status {
            case .idle:
                Circle().fill(p.success).frame(width: 7, height: 7)
                Text(L("synced")).foregroundStyle(p.muted)
            case .syncing:
                ProgressView().controlSize(.mini)
                Text(L("syncing")).foregroundStyle(p.muted)
            case let .failed(message):
                Circle().fill(p.danger).frame(width: 7, height: 7)
                Text(L("sync_failed", message)).foregroundStyle(p.danger).lineLimit(2)
            }
        }
        .font(.subheadline)
    }
}

private struct EmptyState: View {
    @Environment(\.palette) private var p
    let text: String

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(p.surface3).frame(width: 56, height: 56)
                Image(systemName: "key").font(.system(size: 24)).foregroundStyle(p.faint)
            }
            Text(text).font(.callout).foregroundStyle(p.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
}

struct ItemRow: View {
    @Environment(\.palette) private var p
    let item: ItemSummary

    var body: some View {
        HStack(spacing: 14) {
            Monogram(title: item.title, size: 40, icon: kindIcon(item.kind))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(item.title).font(.body.weight(.medium)).foregroundStyle(p.text).lineLimit(1)
                    if item.favorite { Image(systemName: "star.fill").font(.system(size: 11)).foregroundStyle(p.warning) }
                }
                Text(item.username.isEmpty ? (item.kind == "login" ? L("no_username") : kindLabel(item.kind)) : item.username)
                    .font(.subheadline).foregroundStyle(p.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            if item.hasPasskey {
                Image(systemName: "person.badge.key").font(.system(size: 14)).foregroundStyle(p.faint).accessibilityLabel(L("passkey_saved"))
            }
        }
    }
}

// MARK: - Detail

struct ItemDetailView: View {
    @Environment(\.palette) private var p
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var store: VaultStore
    @EnvironmentObject private var toaster: Toaster
    let vault: Vault
    let id: String
    let onEdit: () -> Void
    /// The item is gone (trashed here, or removed by a sync): leave the page.
    let onGone: () -> Void
    @State private var item: ItemDetail?
    @State private var passwordShown = false

    var body: some View {
        Group {
            if let i = item {
                content(i)
            } else {
                Color.clear
            }
        }
        .background(p.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if item?.kind == "login" {
                ToolbarItem(placement: .topBarTrailing) {
                    Pill(title: L("edit"), icon: "pencil", filled: true, action: onEdit)
                }
            }
        }
        .onChange(of: store.revision, initial: true) { _, _ in reload() }
        .onChange(of: id, initial: false) { _, _ in
            passwordShown = false
            reload()
        }
    }

    private func reload() {
        let found = vault.item(id: id)
        item = found
        if found == nil { onGone() }
    }

    private func copy(_ what: String, _ value: String, secret: Bool) {
        Clipboard.copy(value, secret: secret)
        toaster.show(L("copied", what))
    }

    private func content(_ i: ItemDetail) -> some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Monogram(title: i.title, size: 56, icon: kindIcon(i.kind))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(i.title).font(.title2.weight(.semibold)).foregroundStyle(p.text)
                            if i.favorite { Image(systemName: "star.fill").font(.system(size: 14)).foregroundStyle(p.warning) }
                        }
                        HStack(spacing: 6) {
                            Text(kindLabel(i.kind))
                            if i.hasPasskey {
                                Text("·").foregroundStyle(p.faint)
                                Label(L("passkey"), systemImage: "person.badge.key")
                            }
                        }
                        .font(.subheadline).foregroundStyle(p.muted)
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 8, trailing: 4))
            }

            Section {
                FieldRow(label: L("username")) {
                    Text(i.username.isEmpty ? L("no_username") : i.username).font(.body).foregroundStyle(i.username.isEmpty ? p.faint : p.text).textSelection(.enabled)
                } trailing: {
                    if !i.username.isEmpty { IconAction(icon: "doc.on.doc", label: L("copy")) { copy(L("username"), i.username, secret: false) } }
                }
                .surfaceRow(p)
                if !i.password.isEmpty {
                    FieldRow(label: L("password")) {
                        Text(passwordShown ? i.password : "••••••••••••")
                            .font(passwordShown ? .system(.body, design: .monospaced) : .body)
                            .foregroundStyle(p.text)
                            .textSelection(.enabled)
                    } trailing: {
                        IconAction(icon: passwordShown ? "eye.slash" : "eye", label: L(passwordShown ? "hide" : "show")) { passwordShown.toggle() }
                        IconAction(icon: "doc.on.doc", label: L("copy")) { copy(L("password"), i.password, secret: true) }
                    }
                    .surfaceRow(p)
                }
                if i.hasTotp {
                    TotpRow(vault: vault, id: id) { code in copy(L("totp"), code, secret: true) }.surfaceRow(p)
                }
            } header: {
                SectionHeader(text: L("account"))
            }

            if !i.urls.isEmpty {
                Section {
                    ForEach(Array(i.urls.enumerated()), id: \.offset) { _, u in
                        let web = u.hasPrefix("http://") || u.hasPrefix("https://")
                        HStack(spacing: 0) {
                            Text(u.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: ""))
                                .font(.callout).foregroundStyle(web ? p.accent : p.text).lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if web, let url = URL(string: u) {
                                IconAction(icon: "arrow.up.right.square", label: L("open")) { openURL(url) }
                            }
                            IconAction(icon: "doc.on.doc", label: L("copy")) { copy(L("website"), u, secret: false) }
                        }
                        .surfaceRow(p)
                    }
                } header: {
                    SectionHeader(text: L("websites"))
                }
            }

            if !i.notes.isEmpty {
                Section {
                    Text(i.notes).font(.callout).foregroundStyle(p.text).textSelection(.enabled).surfaceRow(p)
                } header: {
                    SectionHeader(text: L("notes"))
                }
            }

            if !i.fields.isEmpty {
                Section {
                    ForEach(Array(i.fields.enumerated()), id: \.offset) { _, f in
                        FieldRow(label: f.name) {
                            Text(f.protected ? "••••••••" : f.value).font(.body).foregroundStyle(p.text).lineLimit(3)
                        } trailing: {
                            IconAction(icon: "doc.on.doc", label: L("copy")) { copy(f.name, f.value, secret: f.protected) }
                        }
                        .surfaceRow(p)
                    }
                } header: {
                    SectionHeader(text: L("fields"))
                }
            }

            if i.kind != "login" {
                Section {
                    Text(L("edit_on_desktop")).font(.caption).foregroundStyle(p.faint).listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }
}

/// The current code, refreshed every second, with the countdown ring.
struct TotpRow: View {
    @Environment(\.palette) private var p
    let vault: Vault
    let id: String
    let onCopy: (String) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            if let c = (try? vault.totp(id: id)) ?? nil {
                let code = c.code.count == 6 ? "\(c.code.prefix(3)) \(c.code.suffix(3))" : c.code
                let remaining = Int(c.remaining)
                FieldRow(label: L("totp")) {
                    HStack(spacing: 10) {
                        Text(code)
                            .font(.system(size: 22, weight: .medium, design: .monospaced))
                            .foregroundStyle(remaining <= 5 ? p.danger : p.text)
                        TotpRing(remaining: remaining, period: Int(c.period))
                    }
                } trailing: {
                    IconAction(icon: "doc.on.doc", label: L("copy")) { onCopy(c.code) }
                }
            }
        }
    }
}
