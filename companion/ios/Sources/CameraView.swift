import SwiftUI

struct CameraView: View {
    let device: CompanionState
    let visible: Bool
    let pair: () -> Void

    private enum Operation: Equatable { case idle, photo, live }
    @State private var operation: Operation = .idle
    @State private var frame: UIImage?
    @State private var photo: URL?
    @State private var receivingLive = false
    @State private var message: String?
    @State private var steeringEnabled = false
    @State private var requestedPosition: HeadPosition?
    @State private var movingTo: HeadPosition?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ZStack {
                    if frame == nil { SaoirseTheme.stage } else { Color.black }
                    if let frame {
                        Image(uiImage: frame).resizable().scaledToFit()
                            .accessibilityLabel(receivingLive ? "Saoirse’s live camera" : "Photo from Saoirse")
                    } else {
                        VStack(spacing: 9) {
                            Image(systemName: "camera").font(.largeTitle).accessibilityHidden(true)
                            Text(operation == .idle ? "Camera off" : "Opening camera…").font(.headline)
                        }
                        .foregroundStyle(SaoirseTheme.stageText)
                    }
                }
                .aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(.rect(cornerRadius: SaoirseTheme.radius))
                .overlay(alignment: .topLeading) {
                    if receivingLive {
                        Label("Live", systemImage: "record.circle.fill")
                            .padding(.horizontal, 11).padding(.vertical, 7)
                            .font(.subheadline.bold()).foregroundStyle(.white)
                            .background(SaoirseTheme.live, in: Capsule())
                            .padding(12)
                    }
                }
                if let message { Label(message, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.subheadline) }
                if device.pairing == nil {
                    Button("Pair Saoirse", systemImage: "link", action: pair)
                        .buttonStyle(.borderedProminent).controlSize(.large)
                } else {
                    ViewThatFits {
                        HStack(spacing: 10) { liveButton; photoButton }
                        VStack(alignment: .leading, spacing: 10) { liveButton; photoButton }
                    }
                    if !device.online && operation == .idle {
                        Text(device.connectionLabel).foregroundStyle(.secondary).font(.subheadline)
                    }
                    if receivingLive {
                        steeringControls
                    }
                    if operation == .photo {
                        ProgressView("Taking photo…").font(.subheadline)
                    }
                    if let photo, operation == .idle {
                        ShareLink(item: photo) { Label("Share or save photo", systemImage: "square.and.arrow.up") }
                            .frame(minHeight: 44)
                    }
                }
            }
            .padding(.horizontal, SaoirseTheme.inset)
            .padding(.bottom, SaoirseTheme.inset)
        }
        .saoirseCanvas()
        .navigationTitle("Camera")
        .task(id: operation) {
            guard operation != .idle else { return }
            await capture(operation)
        }
        .onChange(of: visible) { _, visible in
            if !visible { stopLive() }
        }
        .onChange(of: device.pairing) {
            operation = .idle
            receivingLive = false
            resetSteering()
            frame = nil
            photo = nil
            message = nil
        }
    }

    private var liveButton: some View {
        Button {
            if operation == .live { stopLive() }
            else {
                message = nil
                frame = nil
                photo = nil
                operation = .live
            }
        } label: {
            Label(operation == .live ? "Stop live view" : "Start live view",
                  systemImage: operation == .live ? "stop.fill" : "play.fill")
        }
        .buttonStyle(.borderedProminent).controlSize(.large)
        .disabled(operation != .live && (!device.online || operation == .photo))
    }

    private var photoButton: some View {
        Button("Take photo", systemImage: "camera") {
            message = nil
            frame = nil
            photo = nil
            operation = .photo
        }
        .buttonStyle(.bordered).controlSize(.large)
        .disabled(!device.online || operation != .idle)
    }

    private var steeringControls: some View {
        VStack(spacing: 12) {
            Toggle(isOn: $steeringEnabled) {
                Label("Camera steering", systemImage: "arrow.up.and.down.and.arrow.left.and.right")
            }
            .frame(minHeight: 44)
            .onChange(of: steeringEnabled) { _, enabled in
                if !enabled { requestedPosition = nil }
            }

            if steeringEnabled {
                Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                    GridRow {
                        direction("Up left", symbol: "arrow.up.left", yaw: -10, pitch: 10)
                        direction("Up", symbol: "arrow.up", yaw: 0, pitch: 10)
                        direction("Up right", symbol: "arrow.up.right", yaw: 10, pitch: 10)
                    }
                    GridRow {
                        direction("Left", symbol: "arrow.left", yaw: -10, pitch: 0)
                        aimButton("Center camera", symbol: "scope", position: .center)
                        direction("Right", symbol: "arrow.right", yaw: 10, pitch: 0)
                    }
                    GridRow {
                        direction("Down left", symbol: "arrow.down.left", yaw: -10, pitch: -10)
                        direction("Down", symbol: "arrow.down", yaw: 0, pitch: -10)
                        direction("Down right", symbol: "arrow.down.right", yaw: 10, pitch: -10)
                    }
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Camera direction pad")
            }
        }
    }

    private var intendedPosition: HeadPosition {
        requestedPosition ?? movingTo ?? device.lastHeadPosition ?? .center
    }

    private func direction(_ label: String, symbol: String, yaw: Int, pitch: Int) -> some View {
        let target = intendedPosition.moved(yawBy: yaw, pitchBy: pitch)
        return aimButton(label, symbol: symbol, position: target)
            .disabled(target == intendedPosition)
    }

    private func aimButton(_ label: String, symbol: String, position: HeadPosition) -> some View {
        Button { requestedPosition = position } label: {
            Image(systemName: symbol).font(.body.weight(.semibold))
                .frame(width: 52, height: 44)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(label)
    }

    private func resetSteering() {
        steeringEnabled = false
        requestedPosition = nil
        movingTo = nil
    }

    private func stopLive() {
        guard operation == .live else { return }
        operation = .idle
        receivingLive = false
        resetSteering()
        frame = nil
    }

    private func capture(_ mode: Operation) async {
        guard let client = device.client else { operation = .idle; return }
        do {
            var action = mode == .photo ? "photo" : "streamStart"
            repeat {
                if let position = requestedPosition, mode == .live {
                    requestedPosition = nil
                    movingTo = position
                    do {
                        try await device.sendControl(position.command, using: client)
                        try Task.checkCancellation()
                        message = nil
                    } catch {
                        try Task.checkCancellation()
                        message = error.localizedDescription
                    }
                    movingTo = nil
                }
                try Task.checkCancellation()
                let data = try await client.send("command", method: "POST", body: RobotCommand(action: action))
                try Task.checkCancellation()
                guard operation == mode else { return }
                guard let image = UIImage(data: data) else { throw CompanionError.message("The camera sent an unreadable image.") }
                if mode == .photo {
                    let directory = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                               appropriateFor: nil, create: true)
                    let url = directory.appending(path: "Saoirse photo.jpg")
                    try data.write(to: url, options: [.atomic, .completeFileProtection])
                    photo = url
                    frame = image
                    operation = .idle
                } else {
                    frame = image
                    receivingLive = true
                    action = "frame"
                    try await Task.sleep(for: .milliseconds(180))
                }
            } while mode == .live && operation == .live
        } catch {
            guard !Task.isCancelled, operation == mode else { return }
            message = error.localizedDescription
            if mode == .live { stopLive() }
            else { operation = .idle }
        }
    }
}
