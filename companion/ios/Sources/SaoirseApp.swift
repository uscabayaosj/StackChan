import SwiftUI

let companionTint = Color(uiColor: UIColor { traits in
    traits.userInterfaceStyle == .dark ? UIColor(red: 0.43, green: 0.83, blue: 0.69, alpha: 1) :
        UIColor(red: 0.03, green: 0.38, blue: 0.30, alpha: 1)
})

@main
struct SaoirseApp: App {
    var body: some Scene {
        WindowGroup { CompanionTabs() }
    }
}

private struct CompanionTabs: View {
    @State private var device = CompanionState()
    @State private var pairing = false
    @State private var tab = 0
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack {
                ControlView(device: device, pair: { pairing = true })
            }
            .tabItem { Label("Saoirse", systemImage: "face.smiling") }.tag(0)

            NavigationStack {
                CameraView(device: device, visible: tab == 1 && scenePhase == .active, pair: { pairing = true })
            }
            .tabItem { Label("Camera", systemImage: "camera") }.tag(1)

            NavigationStack {
                HistoryView(device: device, pair: { pairing = true })
            }
            .tabItem { Label("History", systemImage: "bubble.left.and.bubble.right") }.tag(2)

            NavigationStack {
                SettingsView(device: device, pair: { pairing = true })
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }.tag(3)
        }
        .tint(companionTint)
        .sheet(isPresented: $pairing) { PairingView(device: device) }
        .task(id: scenePhase == .active ? device.pairing : nil) {
            if scenePhase == .active { await device.monitor() }
        }
    }
}

struct PairingView: View {
    let device: CompanionState
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var token = ""
    @State private var error: String?
    @State private var connecting = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://relay.example.com", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Relay address")
                    SecureField("Pairing token", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: {
                    Text("Remote access")
                } footer: {
                    Text("Use the address and companion token from your Saoirse relay. Pairing works even if the robot is offline.")
                }

                if let error { Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) } }
                Section {
                    Button {
                        connecting = true
                        error = nil
                    } label: {
                        HStack {
                            Text("Verify and pair")
                            if connecting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(address.isEmpty || token.isEmpty || connecting)
                }
            }
            .navigationTitle("Pair Saoirse")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task(id: connecting) {
                guard connecting else { return }
                defer { connecting = false }
                do {
                    try await device.pair(Pairing(address: address, token: token))
                    dismiss()
                } catch {
                    if !Task.isCancelled { self.error = error.localizedDescription }
                }
            }
        }
        .onAppear { address = device.pairing?.server.absoluteString ?? "" }
    }
}

struct ControlView: View {
    let device: CompanionState
    let pair: () -> Void
    @State private var yaw = 0.0
    @State private var pitch = 0.0
    @State private var volumeDraft: Int?
    @State private var brightnessDraft: Int?
    @State private var pending: RobotCommand?
    @State private var feedback: String?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ConnectionFace(device: device, pair: pair)
                if let routeID = device.status?.directionsId {
                    LatestDirectionsView(device: device, routeID: routeID)
                        .id(routeID)
                        .id(device.pairing)
                }
                if let feedback {
                    Label(feedback, systemImage: failed ? "exclamationmark.circle" : "checkmark.circle")
                        .foregroundStyle(failed ? Color.red : Color.secondary)
                        .font(.subheadline).accessibilityAddTraits(.updatesFrequently)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("Head position").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    controlSlider("Turn", value: $yaw, range: -45...45, unit: "°")
                    controlSlider("Tilt", value: $pitch, range: 0...45, unit: "°")
                    ViewThatFits {
                        HStack { moveButton; centerButton }
                        VStack(alignment: .leading) { moveButton; centerButton }
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 14) {
                    Text("Speaker and display").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    levelControl("Volume", action: "volume", button: "Set speaker volume",
                                 reported: device.status?.volume, draft: $volumeDraft)
                    levelControl("Brightness", action: "brightness", button: "Set brightness",
                                 reported: device.status?.brightness, draft: $brightnessDraft)
                }
            }
            .padding(.horizontal, 24).padding(.bottom, 24)
        }
        .navigationTitle("Saoirse")
        .toolbar { if pending != nil { ToolbarItem { ProgressView().accessibilityLabel("Sending command") } } }
        .onChange(of: device.pairing) {
            volumeDraft = nil
            brightnessDraft = nil
            pending = nil
            feedback = nil
        }
        .onChange(of: device.online) { _, online in
            if !online {
                volumeDraft = nil
                brightnessDraft = nil
            }
        }
        .task(id: pending?.action) {
            guard let command = pending, let client = device.client else { return }
            defer { pending = nil }
            do {
                try await device.sendControl(command, using: client)
                guard !Task.isCancelled, device.client == client else { return }
                if command.action == "volume" { volumeDraft = nil }
                if command.action == "brightness" { brightnessDraft = nil }
                feedback = switch command.action {
                    case "head": "Head control accepted."
                    case "volume": "Speaker volume command accepted."
                    default: "Brightness command accepted."
                }
                failed = false
            } catch {
                if !Task.isCancelled, device.client == client { feedback = error.localizedDescription; failed = true }
            }
        }
    }

    private var moveButton: some View {
        Button("Move head") { submit(.init(action: "head", yaw: Int(yaw), pitch: Int(pitch))) }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(!device.online || pending != nil)
    }

    private var centerButton: some View {
        Button("Center") { yaw = 0; pitch = 0; submit(.init(action: "head", yaw: 0, pitch: 0)) }
            .buttonStyle(.bordered).controlSize(.large)
            .disabled(!device.online || pending != nil)
    }

    private func controlSlider(_ label: String, value: Binding<Double>, range: ClosedRange<Double>, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(label)
                Spacer()
                Text("\(Int(value.wrappedValue))\(unit)").monospacedDigit().foregroundStyle(.secondary)
            }
            .accessibilityHidden(true)
            Slider(value: value, in: range, step: 1) { Text(label) }
                .frame(minHeight: 44)
                .accessibilityValue("\(Int(value.wrappedValue))\(unit)")
        }
    }

    private func levelControl(_ label: String, action: String, button: String,
                              reported: Int?, draft: Binding<Int?>) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(label)
                Spacer()
                Group {
                    if let reported {
                        if device.online { Text("\(reported)%") }
                        else { Text("Last reported \(reported)%") }
                    } else if device.pairing != nil && device.status == nil && device.connectionProblem == nil {
                        Text("Loading…")
                    } else {
                        Text(device.online ? "Not reported" : "Unavailable")
                    }
                }
                .monospacedDigit().foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            if let value = draft.wrappedValue ?? reported {
                Slider(value: Binding(get: { Double(draft.wrappedValue ?? value) },
                                      set: { draft.wrappedValue = Int($0) }), in: 0...100, step: 1) {
                    Text("\(label) target")
                }
                .frame(minHeight: 44)
                .accessibilityValue("\(value)%")
                Button(draft.wrappedValue.map { "\(button) to \($0)%" } ?? button) {
                    if let target = draft.wrappedValue { submit(.init(action: action, value: target)) }
                }
                .frame(minHeight: 44)
                .disabled(draft.wrappedValue == nil)
            } else if device.online {
                Menu("Choose \(label.lowercased())") {
                    ForEach(Array(stride(from: 0, through: 100, by: 10)), id: \.self) { level in
                        Button("\(level)%") { draft.wrappedValue = level }
                    }
                }
                .frame(minHeight: 44)
            }
        }
        .disabled(!device.online || pending != nil)
    }

    private func submit(_ command: RobotCommand) {
        feedback = nil
        pending = command
    }
}

private struct ConnectionFace: View {
    let device: CompanionState
    let pair: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .title2) private var eyeWidth = 27.0
    @ScaledMetric(relativeTo: .title2) private var eyeHeight = 38.0

    var body: some View {
        VStack(spacing: 15) {
            HStack(spacing: 19) {
                ForEach(0..<2) { _ in
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color(red: 0.66, green: 0.99, blue: 0.62))
                        .frame(width: min(eyeWidth, 54), height: device.online ? min(eyeHeight, 68) : 7)
                        .frame(height: min(eyeHeight, 68))
                }
            }
            .accessibilityHidden(true)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.26), value: device.online)
            if device.pairing == nil {
                Button(action: pair) { Label("Pair Saoirse", systemImage: "link") }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.76, green: 1, blue: 0.71))
                    .foregroundStyle(Color(red: 0.04, green: 0.16, blue: 0.12))
                    .controlSize(.large)
            } else {
                Text(device.connectionLabel).font(.headline).foregroundStyle(.white)
            }
            if let problem = device.connectionProblem {
                Text(problem).font(.footnote).foregroundStyle(Color(red: 0.78, green: 0.89, blue: 0.82))
            } else if let lastSeen = device.status?.lastSeen, !device.online {
                Text("Last seen \(lastSeen, style: .relative) ago").font(.footnote)
                    .foregroundStyle(Color(red: 0.78, green: 0.89, blue: 0.82))
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(23)
        .background(Color(red: 0.035, green: 0.13, blue: 0.105), in: RoundedRectangle(cornerRadius: 16))
    }
}
