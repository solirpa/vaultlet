import SwiftUI

/// The desktop app's tonal design system (apps/desktop/src/styles.css), as on Android:
/// hierarchy from surface levels rather than outlines, one accent, hairlines only where tone
/// is not enough.
struct Palette {
    let bg: Color
    let surface: Color
    let surface2: Color
    let surface3: Color
    let text: Color
    let muted: Color
    let faint: Color
    let accent: Color
    let accentSoft: Color
    let danger: Color
    let success: Color
    let warning: Color
    let hairline: Color
    let toast: Color
    let dark: Bool

    static let light = Palette(
        bg: Color(hex: 0xF5F5F7), surface: Color(hex: 0xFFFFFF), surface2: Color(hex: 0xF1F1F4), surface3: Color(hex: 0xE8E8EC),
        text: Color(hex: 0x1D1D1F), muted: Color(hex: 0x6E6E73), faint: Color(hex: 0xA1A1A6),
        accent: Color(hex: 0x2F6BFF), accentSoft: Color(hex: 0x2F6BFF, alpha: 0.12), danger: Color(hex: 0xD93A32), success: Color(hex: 0x1E9E57),
        warning: Color(hex: 0xC9870A), hairline: Color(hex: 0x000000, alpha: 0.06), toast: Color(hex: 0x1D1D1F), dark: false
    )

    static let dark = Palette(
        bg: Color(hex: 0x1C1C1E), surface: Color(hex: 0x232327), surface2: Color(hex: 0x2C2C31), surface3: Color(hex: 0x36363C),
        text: Color(hex: 0xF5F5F7), muted: Color(hex: 0xA0A0A6), faint: Color(hex: 0x6E6E75),
        accent: Color(hex: 0x5B8CFF), accentSoft: Color(hex: 0x5B8CFF, alpha: 0.2), danger: Color(hex: 0xFF6B63), success: Color(hex: 0x41C278),
        warning: Color(hex: 0xE8AD3A), hairline: Color(hex: 0xFFFFFF, alpha: 0.08), toast: Color(hex: 0x3A3A40), dark: true
    )

    static func of(_ scheme: ColorScheme) -> Palette { scheme == .dark ? dark : light }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }

    /// HSL like CSS / Android's `Color.hsl`, so an item gets the same colour everywhere.
    static func hsl(_ hue: Double, _ saturation: Double, _ lightness: Double) -> Color {
        let v = lightness + saturation * min(lightness, 1 - lightness)
        let s = v == 0 ? 0 : 2 * (1 - lightness / v)
        return Color(hue: hue / 360, saturation: s, brightness: v)
    }
}

/// The current palette, from the environment's colour scheme.
struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.light
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

/// Installs the palette for the colour scheme and the page background.
struct Themed<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }

    var body: some View {
        let p = Palette.of(scheme)
        content()
            .environment(\.palette, p)
            .tint(p.accent)
            .background(p.bg.ignoresSafeArea())
    }
}

// MARK: - Brand

/// FNV-1a, same as the desktop's `hash()`.
func monogramHue(_ s: String) -> Double {
    var h: UInt32 = 0x811c9dc5
    for u in s.unicodeScalars {
        h ^= UInt32(truncatingIfNeeded: u.value)
        h = h &* 0x01000193
    }
    return Double(h % 360)
}

/// Gradient monogram tile (desktop `.monogram`): hue from the title.
struct Monogram: View {
    @Environment(\.palette) private var p
    let title: String
    var size: CGFloat = 40
    var icon: String? = nil

    var body: some View {
        let key = title.trimmingCharacters(in: .whitespaces).lowercased()
        let hue = monogramHue(key.isEmpty ? "?" : key)
        let top = p.dark ? Color.hsl(hue, 0.52, 0.50) : Color.hsl(hue, 0.72, 0.64)
        let bottom = p.dark ? Color.hsl(hue, 0.50, 0.40) : Color.hsl(hue, 0.64, 0.50)
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .fill(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
            if let icon {
                Image(systemName: icon).font(.system(size: size * 0.42, weight: .medium)).foregroundStyle(.white)
            } else {
                let initial = String(key.prefix(1)).uppercased()
                Text(initial.isEmpty ? "?" : initial)
                    .font(.system(size: size * 0.44, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
    }
}

/// The desktop logo: accent gradient tile with a key.
struct VaultLogo: View {
    @Environment(\.palette) private var p
    var size: CGFloat = 64

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(LinearGradient(colors: [p.accent.opacity(0.85), p.accent, p.accent.opacity(0.75)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .shadow(color: p.accent.opacity(0.45), radius: 14, y: 6)
            Image(systemName: "key.fill")
                .font(.system(size: size * 0.42, weight: .semibold))
                .rotationEffect(.degrees(-45))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Inputs and buttons

/// Filled field on surface-2, label above (desktop `.input`).
struct FilledField: View {
    @Environment(\.palette) private var p
    let label: String?
    @Binding var text: String
    var placeholder: String = ""
    var secret = false
    var mono = false
    var multiline = false
    var keyboard: UIKeyboardType = .default
    var submitLabel: SubmitLabel = .done
    var onSubmit: (() -> Void)? = nil
    @State private var visible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label).font(.subheadline).foregroundStyle(p.muted).padding(.leading, 4)
            }
            HStack(spacing: 4) {
                input
                    .font(mono ? .system(.body, design: .monospaced) : .body)
                    .foregroundStyle(p.text)
                    .keyboardType(secret ? .default : keyboard)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(submitLabel)
                    .onSubmit { onSubmit?() }
                    .padding(.vertical, 13)
                if secret {
                    Button { visible.toggle() } label: {
                        Image(systemName: visible ? "eye.slash" : "eye").foregroundStyle(p.muted).frame(width: 40, height: 40)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L(visible ? "hide" : "show"))
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, secret ? 4 : 14)
            .frame(minHeight: 50)
            .background(p.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    @ViewBuilder private var input: some View {
        if secret && !visible {
            SecureField(placeholder, text: $text)
        } else if multiline {
            TextField(placeholder, text: $text, axis: .vertical).lineLimit(3...8)
        } else {
            TextField(placeholder, text: $text)
        }
    }
}

struct PrimaryButton: View {
    @Environment(\.palette) private var p
    let title: String
    var enabled = true
    var busy = false
    let action: () -> Void

    var body: some View {
        let on = enabled && !busy
        Button(action: action) {
            ZStack {
                if busy {
                    ProgressView().tint(.white)
                } else {
                    Text(title).font(.headline).foregroundStyle(on ? .white : p.faint)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(on || busy ? p.accent : p.surface3, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!on)
    }
}

struct TonalButton: View {
    @Environment(\.palette) private var p
    let title: String
    var icon: String? = nil
    var color: Color? = nil
    let action: () -> Void

    var body: some View {
        let c = color ?? p.accent
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { Image(systemName: icon) }
                Text(title).font(.headline)
            }
            .foregroundStyle(c)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(c.opacity(p.dark ? 0.2 : 0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// Small accent pill (desktop toolbar "+ New" / "Edit").
struct Pill: View {
    @Environment(\.palette) private var p
    let title: String
    var icon: String? = nil
    var filled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 14, weight: .semibold)) }
                Text(title).font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(filled ? .white : p.accent)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(filled ? p.accent : p.accentSoft, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// Round icon button for row actions (copy, show, open).
struct IconAction: View {
    @Environment(\.palette) private var p
    let icon: String
    let label: String
    var tint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(tint ?? p.muted)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }
}

/// A row inside a grouped section: label above value, trailing actions.
struct FieldRow<Value: View, Trailing: View>: View {
    @Environment(\.palette) private var p
    let label: String
    @ViewBuilder let value: () -> Value
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.caption).foregroundStyle(p.muted)
                value()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.vertical, 6)
    }
}

// MARK: - TOTP

/// Countdown ring next to the code (desktop TotpRing); red in the last 5 seconds.
struct TotpRing: View {
    @Environment(\.palette) private var p
    let remaining: Int
    let period: Int

    var body: some View {
        let urgent = remaining <= 5
        let color = urgent ? p.danger : p.accent
        ZStack {
            Circle().stroke(p.surface3, lineWidth: 2.4)
            Circle()
                .trim(from: 0, to: CGFloat(remaining) / CGFloat(max(period, 1)))
                .stroke(color, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(remaining)").font(.system(size: 9, weight: .semibold)).foregroundStyle(color)
        }
        .frame(width: 24, height: 24)
    }
}

// MARK: - Toast

/// Short confirmations ("Password copied"), shown as a dark pill over the bottom of the screen.
@MainActor
final class Toaster: ObservableObject {
    @Published var message: String?
    private var hideTask: Task<Void, Never>?

    func show(_ text: String) {
        message = text
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            if !Task.isCancelled { message = nil }
        }
    }
}

struct ToastOverlay: ViewModifier {
    @Environment(\.palette) private var p
    @EnvironmentObject private var toaster: Toaster

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message = toaster.message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(p.toast, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: toaster.message)
    }
}

extension View {
    func toastOverlay() -> some View { modifier(ToastOverlay()) }

    /// Grouped-list row on the surface colour.
    func surfaceRow(_ p: Palette) -> some View {
        listRowBackground(p.surface)
    }
}

// MARK: - Item kinds

func kindIcon(_ kind: String) -> String? {
    switch kind {
    case "card": return "creditcard"
    case "note": return "note.text"
    case "identity": return "person"
    default: return nil
    }
}

func kindLabel(_ kind: String) -> String {
    switch kind {
    case "card": return L("kind_card")
    case "note": return L("kind_note")
    case "identity": return L("kind_identity")
    default: return L("kind_login")
    }
}
