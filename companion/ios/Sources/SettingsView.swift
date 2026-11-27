import SwiftUI

struct SettingsView: View {
    let device: CompanionState
    let pair: () -> Void
    @State private var unpairing = false
    @State private var error: String?

    var body: some View {
        List {
            Section("Robot") {
                NavigationLink {
                    WiFiSetupView()
                } label: {
                    Label("Wi-Fi networks", systemImage: "wifi")
                }
                NavigationLink {
                    ProfilesView(device: device, pair: pair)
                } label: {
                    Label("AI profiles", systemImage: "slider.horizontal.3")
                }
            }
            Section("Remote access") {
                if let relay = device.pairing?.server.host() {
                    LabeledContent("Relay", value: relay)
                    Button("Change pairing", systemImage: "link", action: pair)
                    Button("Remove pairing", systemImage: "link.badge.minus", role: .destructive) { unpairing = true }
                } else {
                    Button("Pair Saoirse", systemImage: "link", action: pair)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Settings")
        .alert("Remove this pairing?", isPresented: $unpairing) {
            Button("Remove", role: .destructive) {
                do { try device.unpair(); error = nil }
                catch { self.error = error.localizedDescription }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You’ll need the relay address and pairing token to reconnect.")
        }
    }
}

private struct ProfilesView: View {
    let device: CompanionState
    let pair: () -> Void
    @State private var archive: ProfileArchive?
    @State private var problem: String?
    @State private var busy = false
    @State private var editor: ProfileDraft?
    @State private var removing: SavedProfile?

    var body: some View {
        List {
            if device.client == nil {
                Button("Pair Saoirse", systemImage: "link", action: pair)
            } else if let archive {
                let active = archive.profiles.first { $0.id == archive.active }
                Section {
                    profileSummary(active?.profile ?? archive.defaults)
                    if active != nil {
                        Button("Restore server default") { Task { await activate(nil) } }.disabled(busy)
                    }
                } header: { Text("Active profile") } footer: { Text("Changes take effect the next time Saoirse starts a conversation.") }
                Section {
                    Button("New profile", systemImage: "plus") {
                        var defaults = active?.profile ?? archive.defaults
                        defaults.name = ""
                        editor = ProfileDraft(profile: defaults)
                    }
                    ForEach(archive.profiles) { saved in
                        NavigationLink {
                            profileDetail(saved, active: archive.active == saved.id)
                        } label: {
                            profileSummary(saved.profile)
                        }
                    }
                } header: { Text("Saved versions") }
            } else if problem == nil {
                ProgressView("Loading profiles…")
            } else {
                Button("Try again") { Task { await reload() } }
            }
            if let problem { Text(problem).foregroundStyle(.red) }
        }
        .navigationTitle("AI profiles")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task(id: device.pairing) { archive = nil; await reload() }
        .sheet(item: $editor) { draft in
            ProfileEditor(profile: draft.profile, backends: archive?.backends ?? ["primary"], save: save)
        }
        .alert("Delete saved profile?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Delete", role: .destructive) {
                guard let id = removing?.id else { return }
                removing = nil
                Task { await remove(id) }
            }
            Button("Cancel", role: .cancel) { removing = nil }
        }
    }

    private func profileSummary(_ profile: AIProfile) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(profile.name)
            Text(profile.model).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func profileDetail(_ saved: SavedProfile, active: Bool) -> some View {
        List {
            Section("Backend") {
                LabeledContent("Connection", value: backendLabel(saved.profile.backend))
                LabeledContent("Model", value: saved.profile.model)
            }
            Section("Voice") {
                LabeledContent("ElevenLabs voice ID", value: saved.profile.voiceId)
                LabeledContent("Speech model", value: saved.profile.voiceModel)
                LabeledContent("Speech gain", value: saved.profile.gain.formatted())
            }
            if !saved.profile.persona.isEmpty {
                Section("Persona") { Text(saved.profile.persona).textSelection(.enabled) }
            }
            Section {
                if active { Label("Active profile", systemImage: "checkmark.circle.fill") }
                else { Button("Use this profile") { Task { await activate(saved.id) } }.disabled(busy) }
                Button("Edit as new version") { editor = ProfileDraft(profile: saved.profile) }
                if !active {
                    Button("Delete saved profile", role: .destructive) { removing = saved }.disabled(busy)
                }
                if let problem { Text(problem).foregroundStyle(.red) }
            }
        }
        .navigationTitle(saved.profile.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func reload() async {
        await perform { try await fetch($0) }
    }

    private func fetch(_ client: CompanionClient) async throws {
        let result: ProfileArchive = try await client.get("profiles")
        try Task.checkCancellation()
        if device.client == client { archive = result }
    }

    private func activate(_ id: String?) async {
        await perform {
            _ = try await $0.send("active-profile", method: "PUT", body: ActiveProfile(id: id))
            try await fetch($0)
        }
    }

    private func remove(_ id: String) async {
        await perform {
            try await $0.delete("profiles", query: [URLQueryItem(name: "id", value: id)])
            try await fetch($0)
        }
    }

    private func perform(_ action: (CompanionClient) async throws -> Void) async {
        guard let client = device.client, !busy else { return }
        busy = true
        problem = nil
        defer { busy = false }
        do { try await action(client) }
        catch { if !Task.isCancelled && device.client == client { problem = error.localizedDescription } }
    }

    private func save(_ profile: AIProfile, activate: Bool) async throws -> String? {
        guard let client = device.client else { throw CompanionError.message("Pair Saoirse before saving.") }
        struct Saved: Decodable { let id: String }
        let data = try await client.send("profiles", method: "POST", body: profile)
        if activate {
            do {
                let saved = try JSONDecoder().decode(Saved.self, from: data)
                _ = try await client.send("active-profile", method: "PUT", body: ActiveProfile(id: saved.id))
            } catch {
                await reload()
                return "The version was saved. Activation could not be confirmed. \(error.localizedDescription)"
            }
        }
        await reload()
        return nil
    }
}

private struct ProfileDraft: Identifiable {
    let id = UUID()
    let profile: AIProfile
}

private func backendLabel(_ value: String) -> String {
    value == "fallback" ? "Fallback connection" : "Primary connection"
}

private struct ProfileEditor: View {
    @State var profile: AIProfile
    let backends: [String]
    let save: (AIProfile, Bool) async throws -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var saved = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Version") { TextField("Profile name", text: $profile.name) }
                Section {
                    Picker("Connection", selection: $profile.backend) {
                        ForEach(backends, id: \.self) { Text(backendLabel($0)).tag($0) }
                    }
                    TextField("Model ID", text: $profile.model).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("LLM backend") } footer: { Text("Connections and provider keys are configured on the relay.") }
                Section("Voice") {
                    TextField("ElevenLabs voice ID", text: $profile.voiceId).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Speech model ID", text: $profile.voiceModel).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Stepper("Speech gain \(profile.gain.formatted(.number.precision(.fractionLength(2))))×",
                            value: $profile.gain, in: 0.5...2, step: 0.05)
                }
                Section {
                    TextField("How should Saoirse speak and act?", text: $profile.persona, axis: .vertical)
                        .lineLimit(4...8).accessibilityLabel("Persona instructions")
                } header: { Text("Persona") } footer: { Text("Adds instructions to Saoirse’s existing persona.") }
                if let problem { Section { Text(problem).foregroundStyle(.red) } }
                if saving { ProgressView("Saving…") }
                if saved {
                    Button("Done") { dismiss() }
                } else {
                    Section {
                        Button("Save and use") { submit(true) }.disabled(!canSave)
                        Button("Save version only") { submit(false) }.disabled(!canSave)
                    }
                }
            }
            .navigationTitle("Save AI profile")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(saving)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(saved ? "Close" : "Cancel") { dismiss() }.disabled(saving) } }
        }
    }

    private var canSave: Bool {
        !saving && ![profile.name, profile.model, profile.voiceId, profile.voiceModel].contains {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func submit(_ activate: Bool) {
        saving = true
        problem = nil
        Task {
            defer { saving = false }
            do {
                if let problem = try await save(profile, activate) { self.problem = problem; saved = true }
                else { dismiss() }
            } catch { problem = error.localizedDescription }
        }
    }
}
