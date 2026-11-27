import SwiftUI

struct HistoryView: View {
    let device: CompanionState
    let pair: () -> Void

    @State private var page: ConversationPage?
    @State private var turns: [ConversationTurn] = []
    @State private var search = ""
    @State private var problem: String?
    @State private var working = false
    @State private var confirmingDelete = false

    var body: some View {
        Group {
            if device.client == nil {
                ContentUnavailableView {
                    Label("Conversation history", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Pair Saoirse to archive and revisit conversations.")
                } actions: {
                    Button("Pair Saoirse", action: pair).buttonStyle(.borderedProminent)
                }
                .saoirseCanvas()
            } else {
                List {
                    if let page {
                        Section {
                            Toggle("Archive conversations", isOn: Binding(get: { page.recording }, set: changeRecording))
                                .disabled(working)
                        } footer: {
                            Text("New transcripts are stored on your relay when this is on. Calendar exchanges are omitted.")
                        }
                        .listRowBackground(SaoirseTheme.surface)
                    }
                    if let problem {
                        Section { Text(problem).foregroundStyle(.red) }
                            .listRowBackground(SaoirseTheme.surface)
                    }
                    if page == nil && problem != nil {
                        Button("Try again") { Task { await reload() } }.disabled(working)
                            .listRowBackground(SaoirseTheme.surface)
                    } else if page == nil {
                        ProgressView("Loading conversations…")
                            .listRowBackground(SaoirseTheme.surface)
                    } else if dayGroups.isEmpty {
                        Section {
                            Text(search.isEmpty ? "No archived conversations yet." : "No matches in loaded conversations.")
                                .foregroundStyle(.secondary)
                        }
                        .listRowBackground(SaoirseTheme.surface)
                    }
                    ForEach(dayGroups, id: \.day) { group in
                        Section(group.day.formatted(.dateTime.weekday(.wide).month(.wide).day())) {
                            ForEach(group.conversations) { conversation in
                                NavigationLink {
                                    ConversationDetail(conversation: conversation)
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(conversation.turns[0].user).lineLimit(2)
                                        HStack {
                                            Text(conversation.startedAt, style: .time)
                                            Text(conversation.turns.count == 1 ? "1 exchange" : "\(conversation.turns.count) exchanges")
                                        }
                                        .font(.caption).foregroundStyle(.secondary)
                                    }
                                    .padding(.vertical, 3)
                                }
                            }
                        }
                        .listRowBackground(SaoirseTheme.surface)
                    }
                    if let before = page?.next {
                        Button("Load older conversations") { Task { await reload(before: before) } }.disabled(working)
                            .listRowBackground(SaoirseTheme.surface)
                    }
                }
                .searchable(text: $search, prompt: "Search loaded transcripts")
                .refreshable { await reload() }
                .toolbar {
                    if !turns.isEmpty {
                        ToolbarItem {
                            Menu {
                                Button("Delete all transcripts", systemImage: "trash", role: .destructive) {
                                    confirmingDelete = true
                                }
                            } label: { Label("History options", systemImage: "ellipsis.circle") }
                            .disabled(working)
                        }
                    }
                }
                .saoirseGroupedCanvas()
            }
        }
        .navigationTitle("History")
        .alert("Delete all transcripts?", isPresented: $confirmingDelete) {
            Button("Delete all", role: .destructive) { Task { await delete() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes conversation transcripts from your relay.")
        }
        .task(id: device.pairing) {
            turns = []
            page = nil
            problem = nil
            await reload()
        }
    }

    private var dayGroups: [(day: Date, conversations: [ArchivedConversation])] {
        let sessions = Dictionary(grouping: turns, by: \.session)
        let conversations = sessions.map { id, turns in
            ArchivedConversation(id: id, turns: Array(turns.reversed()))
        }.filter { conversation in
            search.isEmpty || conversation.turns.contains {
                $0.user.localizedCaseInsensitiveContains(search) || $0.reply.localizedCaseInsensitiveContains(search)
            }
        }
        let days = Dictionary(grouping: conversations) { Calendar.current.startOfDay(for: $0.latestAt) }
        return days.keys.sorted(by: >).map { day in
            (day, days[day, default: []].sorted { $0.latestAt > $1.latestAt })
        }
    }

    private func request(_ action: (CompanionClient) async throws -> Void) async {
        guard let client = device.client, !working else { return }
        working = true
        problem = nil
        defer { working = false }
        do { try await action(client) }
        catch { if !Task.isCancelled && device.client == client { problem = error.localizedDescription } }
    }

    private func update(_ client: CompanionClient, before: Int? = nil) async throws {
        let query = before.map { [URLQueryItem(name: "before", value: String($0))] } ?? []
        let result: ConversationPage = try await client.get("history", query: query)
        try Task.checkCancellation()
        guard device.client == client else { return }
        turns = before == nil ? result.turns : turns + result.turns
        page = result
    }

    private func reload(before: Int? = nil) async {
        await request { try await update($0, before: before) }
    }

    private func changeRecording(_ enabled: Bool) {
        Task {
            await request {
                _ = try await $0.send("history", method: "PUT", body: ArchiveSetting(recording: enabled))
                try await update($0)
            }
        }
    }

    private func delete() async {
        await request {
            try await $0.delete("history")
            try await update($0)
        }
    }
}

private struct ArchivedConversation: Identifiable {
    let id: String
    let turns: [ConversationTurn]
    var startedAt: Date { turns[0].at }
    var latestAt: Date { turns[turns.count - 1].at }
}

private struct ConversationDetail: View {
    let conversation: ArchivedConversation

    var body: some View {
        List {
            ForEach(conversation.turns) { turn in
                Section(turn.at.formatted(date: .omitted, time: .shortened)) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("You").font(.caption.bold()).foregroundStyle(.secondary)
                        Text(turn.user).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Saoirse").font(.caption.bold()).foregroundStyle(.secondary)
                        if turn.reply.isEmpty { Text("No reply was recorded.").foregroundStyle(.secondary) }
                        else { Text(turn.reply).textSelection(.enabled) }
                    }
                }
                .listRowBackground(SaoirseTheme.surface)
            }
        }
        .saoirseGroupedCanvas()
        .navigationTitle("Conversation")
        .navigationBarTitleDisplayMode(.inline)
    }
}
