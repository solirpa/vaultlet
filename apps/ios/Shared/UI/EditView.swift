import SwiftUI

private enum TotpEdit: Equatable {
    case keep
    case remove
    case set(String)
}

private struct GeneratorOptions: Equatable {
    var length = 20
    var upper = true
    var lower = true
    var digits = true
    var symbols = true
}

/// Create (`id == nil`) or change a login, in a sheet with its own navigation bar.
struct EditView: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: VaultStore
    let vault: Vault
    let id: String?
    let onSaved: (String) -> Void
    let onTrashed: () -> Void

    @State private var title = ""
    @State private var username = ""
    @State private var password = ""
    @State private var urls: [String] = []
    @State private var notes = ""
    @State private var favorite = false
    @State private var hadTotp = false
    @State private var totp = TotpEdit.keep
    @State private var generator: GeneratorOptions?
    @State private var busy = false
    @State private var error: String?
    @State private var confirmTrash = false
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).font(.subheadline).foregroundStyle(p.danger).listRowBackground(Color.clear) }
                }

                Section {
                    VStack(spacing: 14) {
                        FilledField(label: L("name"), text: $title, submitLabel: .next)
                        FilledField(label: L("username"), text: $username, keyboard: .emailAddress, submitLabel: .next)
                        FilledField(label: L("password"), text: $password, secret: true, mono: true)
                        HStack {
                            Spacer()
                            Pill(title: L("generate"), icon: "wand.and.stars", filled: generator != nil) {
                                if generator == nil { regenerate(GeneratorOptions()) } else { generator = nil }
                            }
                        }
                        if let g = generator {
                            GeneratorPanel(options: g) { regenerate($0) }
                        }
                    }
                    .padding(.vertical, 6)
                    .surfaceRow(p)
                    Toggle(isOn: $favorite) {
                        Label(L("favorite"), systemImage: favorite ? "star.fill" : "star").foregroundStyle(favorite ? p.warning : p.text)
                    }
                    .surfaceRow(p)
                } header: {
                    SectionHeader(text: L("account"))
                }

                Section {
                    switch totp {
                    case .keep where hadTotp:
                        HStack {
                            Text(L("totp_set")).foregroundStyle(p.muted)
                            Spacer()
                            Button(L("totp_replace")) { totp = .set("") }.buttonStyle(.borderless)
                            Button(L("totp_remove"), role: .destructive) { totp = .remove }.buttonStyle(.borderless).foregroundStyle(p.danger)
                        }
                        .surfaceRow(p)
                    case .remove:
                        HStack {
                            Text(L("totp_removed")).foregroundStyle(p.muted)
                            Spacer()
                            Button(L("undo")) { totp = .keep }.buttonStyle(.borderless)
                        }
                        .surfaceRow(p)
                    default:
                        FilledField(label: nil, text: Binding(get: {
                            if case let .set(v) = totp { return v }
                            return ""
                        }, set: { totp = $0.isEmpty && !hadTotp ? .keep : .set($0) }), placeholder: "otpauth://totp/… / JBSWY3DPEHPK3PXP", mono: true)
                        .padding(.vertical, 6)
                        .surfaceRow(p)
                    }
                } header: {
                    SectionHeader(text: L("totp"))
                }

                Section {
                    ForEach(urls.indices, id: \.self) { n in
                        HStack(spacing: 4) {
                            FilledField(label: nil, text: $urls[n], placeholder: "https://", keyboard: .URL, submitLabel: .next)
                            IconAction(icon: "minus.circle", label: L("remove"), tint: p.danger) { urls.remove(at: n) }
                        }
                        .padding(.vertical, 4)
                        .surfaceRow(p)
                    }
                    Button { urls.append("") } label: {
                        Label(L("add_website"), systemImage: "plus").font(.callout.weight(.medium)).foregroundStyle(p.accent)
                    }
                    .surfaceRow(p)
                } header: {
                    SectionHeader(text: L("websites"))
                }

                Section {
                    FilledField(label: nil, text: $notes, multiline: true).padding(.vertical, 6).surfaceRow(p)
                } header: {
                    SectionHeader(text: L("notes"))
                }

                if id != nil {
                    Section {
                        TonalButton(title: L("trash"), icon: "trash", color: p.danger) { confirmTrash = true }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets())
                    } footer: {
                        Text(L("kept_hint")).font(.caption).foregroundStyle(p.faint)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(p.bg)
            .navigationTitle(L(id == nil ? "new_login" : "edit_login"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("cancel")) { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Pill(title: L("save"), filled: true) { save() }
                    }
                }
            }
            .confirmationDialog(L("trash_confirm"), isPresented: $confirmTrash, titleVisibility: .visible) {
                Button(L("trash"), role: .destructive) { trash() }
                Button(L("cancel"), role: .cancel) {}
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let id, let existing = vault.item(id: id) else { return }
        title = existing.title
        username = existing.username
        password = existing.password
        urls = existing.urls
        notes = existing.notes
        favorite = existing.favorite
        hadTotp = existing.hasTotp
    }

    private func regenerate(_ o: GeneratorOptions) {
        generator = o
        if let generated = try? generatePassword(length: UInt32(o.length), upper: o.upper, lower: o.lower, digits: o.digits, symbols: o.symbols) {
            password = generated
        }
    }

    private func save() {
        guard !busy else { return }
        let name = title.trimmingCharacters(in: .whitespaces)
        if name.isEmpty {
            error = L("err_title")
            return
        }
        if case let .set(v) = totp, v.trimmingCharacters(in: .whitespaces).isEmpty {
            error = L("err_totp")
            return
        }
        busy = true
        error = nil
        let totpInput: String?
        switch totp {
        case .keep: totpInput = nil
        case .remove: totpInput = ""
        case let .set(v): totpInput = v.trimmingCharacters(in: .whitespaces)
        }
        let input = ItemInput(
            id: id, title: name, username: username, password: password,
            urls: urls.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
            notes: notes, favorite: favorite, totp: totpInput
        )
        Task {
            do {
                let saved = try await store.saveItem(input)
                onSaved(saved)
            } catch let VaultError.Failed(code, _) where code == "invalid-totp" {
                error = L("err_totp")
                busy = false
            } catch {
                self.error = error.vaultMessage
                busy = false
            }
        }
    }

    private func trash() {
        guard let id, !busy else { return }
        busy = true
        Task {
            do {
                try await store.trashItem(id)
                onTrashed()
            } catch {
                self.error = error.vaultMessage
                busy = false
            }
        }
    }
}

private struct GeneratorPanel: View {
    @Environment(\.palette) private var p
    let options: GeneratorOptions
    let onChange: (GeneratorOptions) -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Text(L("length", options.length)).font(.subheadline).foregroundStyle(p.muted).frame(width: 76, alignment: .leading)
                Slider(value: Binding(get: { Double(options.length) }, set: { value in
                    var o = options
                    o.length = Int(value)
                    onChange(o)
                }), in: 8...64, step: 1)
                IconAction(icon: "arrow.clockwise", label: L("regenerate")) { onChange(options) }
            }
            HStack(spacing: 6) {
                toggle("A-Z", options.upper) { $0.upper.toggle() }
                toggle("a-z", options.lower) { $0.lower.toggle() }
                toggle("0-9", options.digits) { $0.digits.toggle() }
                toggle("!@#", options.symbols) { $0.symbols.toggle() }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(p.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func toggle(_ label: String, _ on: Bool, _ flip: @escaping (inout GeneratorOptions) -> Void) -> some View {
        Button {
            var next = options
            flip(&next)
            if next.upper || next.lower || next.digits || next.symbols { onChange(next) }
        } label: {
            Text(label)
                .font(.subheadline.weight(.medium).monospaced())
                .foregroundStyle(on ? p.accent : p.faint)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
                .background(on ? p.accentSoft : p.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
