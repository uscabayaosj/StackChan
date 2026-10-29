import SwiftUI

@main
struct StackChanWiFiApp: App {
    var body: some Scene { WindowGroup { WiFiSetupView() } }
}

struct WiFiSetupView: View {
    @State private var bluetooth = StackChanBluetooth()
    @State private var ssid = UserDefaults.standard.string(forKey: "lastSSID") ?? ""
    @State private var password = ""
    @Environment(\.openURL) private var openURL
    @FocusState private var focusedField: Field?
    private enum Field { case network, password }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("A new network for your little companion", systemImage: "wifi")
                        .font(.headline)
                    Text("On StackChan, open Settings → Wi-Fi → Change Wi-Fi, then tap Next. Keep your iPhone nearby.")
                        .foregroundStyle(.secondary)
                    Text("Already says “Ready to Configure”? This app can find connections held by iOS, too.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("1 · Choose your StackChan") {
                    ForEach(bluetooth.devices) { device in
                        Button {
                            bluetooth.select(device)
                        } label: {
                            HStack {
                                Image(systemName: "face.smiling")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(device.name).foregroundStyle(.primary)
                                    Text(device.deviceID ?? String(device.id.uuidString.prefix(8)))
                                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                                    if device.alreadyConnected {
                                        Text("Connected to iOS").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if bluetooth.selectedID == device.id {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                                }
                            }
                        }
                        .disabled(bluetooth.isBusy)
                    }
                    Button {
                        bluetooth.findDevices()
                    } label: {
                        HStack {
                            Label("Find StackChan", systemImage: "arrow.clockwise")
                            Spacer()
                            if bluetooth.phase == .scanning { ProgressView() }
                        }
                    }
                    .disabled(bluetooth.isBusy)
                }

                if bluetooth.phase != .success {
                    Section {
                        TextField("Wi-Fi name", text: $ssid)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focusedField, equals: .network).submitLabel(.next)
                            .onSubmit { focusedField = .password }
                            .accessibilityIdentifier("wifiName")
                        SecureField("Wi-Fi password", text: $password)
                            .textContentType(.password)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focusedField, equals: .password).submitLabel(.go)
                            .onSubmit { connectWiFi() }
                            .accessibilityIdentifier("wifiPassword")
                        Button(action: connectWiFi) {
                            HStack {
                                Label("Connect StackChan", systemImage: "wifi")
                                Spacer()
                                if bluetooth.phase == .verifying { ProgressView() }
                            }
                        }
                        .disabled(!bluetooth.canConfigure || bluetooth.isBusy || ssid.isEmpty)
                        .accessibilityIdentifier("connectWiFi")
                    } header: {
                        Text("2 · Enter Wi-Fi details")
                    } footer: {
                        Text("Use a 2.4 GHz network. Leave the password blank only for an open network. Your password is sent directly to StackChan and is not saved by this app.")
                    }
                    .disabled(bluetooth.phase == .verifying)
                }

                Section {
                    Label(bluetooth.message, systemImage: statusIcon)
                        .foregroundStyle(bluetooth.phase == .success ? .green : .primary)
                        .accessibilityIdentifier("connectionStatus")
                    if bluetooth.permissionDenied {
                        Button("Open iPhone Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                    if bluetooth.phase == .success {
                        Button("Set up another network") {
                            password = ""
                            bluetooth.disconnect()
                            bluetooth.findDevices()
                        }
                    }
                }
            }
            .navigationTitle("StackChan Wi-Fi")
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: bluetooth.phase) { _, phase in
                if phase == .success { password = ""; focusedField = nil }
            }
        }
    }

    private var statusIcon: String {
        switch bluetooth.phase {
        case .success: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.circle"
        case .ready: return "link"
        default: return "info.circle"
        }
    }

    private func connectWiFi() {
        guard bluetooth.canConfigure, !bluetooth.isBusy, !ssid.isEmpty else { return }
        focusedField = nil
        bluetooth.configure(ssid: ssid, password: password)
    }
}

#Preview { WiFiSetupView() }
