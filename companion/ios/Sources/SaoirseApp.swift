import SwiftUI

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
        .sheet(isPresented: $pairing) { PairingView(device: device) }
        .tint(SaoirseTheme.action)
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
                .listRowBackground(SaoirseTheme.surface)

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                        .listRowBackground(SaoirseTheme.surface)
                }
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
                .listRowBackground(SaoirseTheme.surface)
            }
            .saoirseGroupedCanvas()
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
            .padding(.horizontal, SaoirseTheme.inset)
            .padding(.bottom, SaoirseTheme.inset)
        }
        .saoirseCanvas()
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let vertical = typeSize >= .xxLarge
        let layout = vertical ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) :
            AnyLayout(HStackLayout(spacing: 14))
        layout {
            Image("SaoirsePortrait")
                .resizable().scaledToFill()
                .frame(width: 138, height: 114)
                .clipped()
                .clipShape(.rect(cornerRadius: 10))
                .accessibilityHidden(true)
            connectionDetails
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(SaoirseTheme.stage, in: .rect(cornerRadius: SaoirseTheme.radius))
    }

    private var connectionDetails: some View {
        VStack(alignment: .leading, spacing: 7) {
            if device.pairing == nil {
                Button(action: pair) { Text("Pair Saoirse") }
                    .buttonStyle(.bordered).controlSize(.large)
                    .tint(SaoirseTheme.stageStatus)
                    .foregroundStyle(SaoirseTheme.stageText)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: statusIcon)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(device.online ? SaoirseTheme.stageStatus : SaoirseTheme.stageSecondary)
                        .accessibilityHidden(true)
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: device.online)
                    Text(statusTitle).font(.headline)
                        .foregroundStyle(SaoirseTheme.stageText)
                }
                .accessibilityAddTraits(.updatesFrequently)
            }
            if let problem = device.connectionProblem {
                Text(problem).font(.footnote).foregroundStyle(SaoirseTheme.stageSecondary)
            } else if let lastSeen = device.status?.lastSeen, !device.online {
                Text("Last seen \(lastSeen, style: .relative) ago")
                    .font(.footnote).foregroundStyle(SaoirseTheme.stageSecondary)
            }
        }
    }

    private var statusTitle: String {
        if device.connectionProblem != nil || device.status == nil { return device.connectionLabel }
        return device.online ? "Online" : "Offline"
    }

    private var statusIcon: String {
        if device.connectionProblem != nil { return "exclamationmark.circle" }
        if device.status == nil { return "ellipsis.circle" }
        return device.online ? "checkmark.circle.fill" : "circle"
    }
}
