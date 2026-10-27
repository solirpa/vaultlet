import AuthenticationServices
import SwiftUI

/// Setup-less auth flow, then the login picker.
struct AutoFillPicker: View {
    let services: [ASCredentialServiceIdentifier]
    /// Record id from a QuickType suggestion: fill it as soon as the vault is open.
    let wanted: String?
    let onPick: (ItemDetail) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            AuthFlow(allowSetup: false) { vault in
                PickerList(vault: vault, services: services, wanted: wanted, onPick: onPick)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("cancel"), action: onCancel)
                }
            }
        }
    }
}

private struct PickerList: View {
    @Environment(\.palette) private var p
    let vault: Vault
    let services: [ASCredentialServiceIdentifier]
    let wanted: String?
    let onPick: (ItemDetail) -> Void
    @State private var query = ""
    @State private var suggested: [ItemSummary] = []
    @State private var results: [ItemSummary] = []

    /// Site shown in the heading: the first service's host.
    private var site: String {
        guard let first = services.first else { return "" }
        if first.type == .URL, let url = URL(string: first.identifier), let host = url.host { return host }
        return first.identifier
    }

    var body: some View {
        List {
            if !site.isEmpty {
                Section {
                    Text(L("autofill_for", site)).font(.subheadline).foregroundStyle(p.muted).lineLimit(1)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            if query.isEmpty && !suggested.isEmpty {
                Section {
                    ForEach(suggested) { item in row(item) }
                } header: {
                    SectionHeader(text: L("autofill_suggested"))
                }
            }
            Section {
                ForEach(results) { item in row(item) }
            } header: {
                SectionHeader(text: L(query.isEmpty ? "all_items" : "results"), count: results.count)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(p.bg)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("search"))
        .navigationTitle(L("autofill_choose"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let wanted, let detail = vault.item(id: wanted) {
                onPick(detail)
                return
            }
            var seen = Set<String>()
            suggested = services.flatMap { service -> [ItemSummary] in
                let url = service.type == .URL ? service.identifier : "https://\(service.identifier)"
                return vault.matches(url: url)
            }.filter { seen.insert($0.id).inserted }
        }
        .task(id: query) {
            let q = query
            results = (q.isEmpty ? vault.items() : vault.search(query: q)).filter { $0.kind == "login" }
        }
    }

    private func row(_ item: ItemSummary) -> some View {
        Button {
            if let detail = vault.item(id: item.id) { onPick(detail) }
        } label: {
            ItemRow(item: item)
        }
        .buttonStyle(.plain)
        .surfaceRow(p)
        .listRowInsets(EdgeInsets(top: 9, leading: 14, bottom: 9, trailing: 14))
    }
}
