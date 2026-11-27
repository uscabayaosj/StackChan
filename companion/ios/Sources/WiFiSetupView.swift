import SwiftUI

struct WiFiSetupView: View {
    @State private var bluetooth = StackChanBluetooth()
    @State private var networks = NetworkProfileStore()
    @State private var editing: NetworkProfile?
    @State private var pending: NetworkProfile?
    @State private var manual = NetworkProfile(id: "manual", ssid: "")
    @Environment(\.openURL) private var openURL

    var body: some View {
        Form {
            Section {
                Label("Choose a network for StackChan", systemImage: "wifi").font(.headline)
                Text("On the robot, open Settings → Wi-Fi → Change Wi-Fi and tap Next. Then tap a saved network below.")
                    .foregroundStyle(.secondary)
            }
            Section {
                ForEach(networks.profiles) { profile in
                    HStack {
                        Button {
                            if networks.savedIDs.contains(profile.id) { connect(profile) }
                            else { editing = profile }
                        } label: {
                            HStack {
                                Image(systemName: profile.id == "Saoirse" ? "personalhotspot" : "wifi")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(profile.ssid).foregroundStyle(.primary)
                                    Text(networks.savedIDs.contains(profile.id) ? "Tap to connect" : "Add details once")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("preset-\(profile.id)")
                        Button { editing = profile } label: { Image(systemName: "pencil.circle") }
                            .buttonStyle(.borderless).accessibilityLabel("Edit \(profile.ssid)")
                    }
                    .disabled(bluetooth.isBusy)
                }
            } header: { Text("Saved networks") } footer: {
                Text("Passwords are stored in this iPhone’s Keychain. For Saoirse, turn on Personal Hotspot and Maximise Compatibility first. UCL eduroam needs the updated robot firmware.")
            }
            Section("StackChan") {
                ForEach(bluetooth.devices) { device in
                    Button { bluetooth.select(device) } label: {
                        HStack {
                            Image(systemName: "face.smiling")
                            VStack(alignment: .leading) {
                                Text(device.name).foregroundStyle(.primary)
                                Text(device.deviceID ?? String(device.id.uuidString.prefix(8)))
                                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if bluetooth.selectedID == device.id { Image(systemName: "checkmark.circle.fill") }
                        }
                    }.disabled(bluetooth.isBusy)
                }
                Button("Find StackChan", systemImage: "arrow.clockwise") { bluetooth.findDevices() }
                    .disabled(bluetooth.isBusy)
                if let pending {
                    Text("Ready to send \(pending.ssid). Choose your robot above if needed.").font(.footnote)
                    Button("Cancel") { self.pending = nil }
                }
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
                if let error = networks.errorMessage { Text(error).foregroundStyle(.red) }
                if bluetooth.phase == .success {
                    Button("Change network again") { bluetooth.disconnect(); bluetooth.findDevices() }
                }
            }
            Section {
                Button("Add saved network", systemImage: "plus") {
                    editing = NetworkProfile(id: UUID().uuidString, ssid: "")
                }
            }
            Section {
                TextField("Wi-Fi name", text: $manual.ssid)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("wifiName")
                SecureField("Wi-Fi password", text: $manual.password)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("wifiPassword")
                Button("Connect StackChan", systemImage: "wifi") { connect(manual) }
                    .disabled(manual.ssid.isEmpty || bluetooth.isBusy)
                    .accessibilityIdentifier("connectWiFi")
            } header: { Text("Other network") } footer: { Text("Use a 2.4 GHz network. These manual details are not saved.") }
        }
        .navigationTitle("Wi-Fi networks")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .sheet(item: $editing) { profile in
            WiFiProfileEditor(profile: profile, saved: networks.savedIDs.contains(profile.id), save: {
                try networks.save($0)
            }, forget: { try networks.forget(profile) })
        }
        .onChange(of: bluetooth.phase) { _, phase in
            if phase == .ready, let profile = pending { pending = nil; bluetooth.configure(profile: profile) }
            if phase == .success { manual.password = "" }
            if phase == .failed { pending = nil }
        }
        .onChange(of: bluetooth.devices.map(\.id)) { _, _ in
            // Reuse only a previously selected robot, never an unknown nearby one.
            guard pending != nil, !bluetooth.isBusy,
                  let id = UserDefaults.standard.string(forKey: "lastStackChanID"),
                  let device = bluetooth.devices.first(where: { $0.id.uuidString == id }) else { return }
            bluetooth.select(device)
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
    private func connect(_ profile: NetworkProfile) {
        if bluetooth.canConfigure && !bluetooth.isBusy { bluetooth.configure(profile: profile) }
        else { pending = profile; bluetooth.disconnect(); bluetooth.findDevices() }
    }
}

private struct WiFiProfileEditor: View {
    @State var profile: NetworkProfile
    let saved: Bool
    let save: (NetworkProfile) throws -> Void
    let forget: () throws -> Void
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Network details") {
                    if !NetworkProfile.presets.contains(where: { $0.id == profile.id }) {
                        TextField("Wi-Fi name", text: $profile.ssid)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    if profile.security == .uclEduroam {
                        TextField("UCL user ID, e.g. abc123@ucl.ac.uk", text: $profile.username)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                            .textContentType(.username)
                        Text("Use your UCL user ID followed by @ucl.ac.uk. Your email address may be different.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    SecureField(profile.security == .uclEduroam ? "UCL password" : "Wi-Fi password", text: $profile.password)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.password)
                    Text("Saved only in this iPhone’s Keychain. Sent directly to your robot over Bluetooth when you connect.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
                if saved {
                    Button("Forget saved details", role: .destructive) {
                        do { try forget(); dismiss() } catch { self.error = error.localizedDescription }
                    }
                }
            }
            .navigationTitle(profile.ssid.isEmpty ? "Add Wi-Fi network" : "Edit Wi-Fi network")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        do { try save(profile); dismiss() } catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
    }
}

#Preview { NavigationStack { WiFiSetupView() } }
