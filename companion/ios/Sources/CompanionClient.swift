import Foundation
import Security
import Observation

struct Pairing: Codable, Hashable {
    let server: URL
    let token: String

    init(address: String, token: String) throws {
        guard let components = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "https", components.host?.isEmpty == false,
              components.user == nil, components.password == nil, components.query == nil,
              components.fragment == nil, ["", "/"].contains(components.path),
              let url = components.url else {
            throw CompanionError.message("Enter the relay’s HTTPS address, without a path.")
        }
        let key = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.count >= 32 else { throw CompanionError.message("Enter the full pairing token.") }
        self.server = url
        self.token = key
    }

    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.uscabayao.SaoirseCompanion",
        kSecAttrAccount as String: "relay"
    ]

    static func load() throws -> Self? {
        var item: CFTypeRef?
        let parameters = query.merging([
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne
        ]) { _, value in value }
        let status = SecItemCopyMatching(parameters as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw CompanionError.message("Couldn’t read the pairing from Keychain. Unlock your iPhone and reopen Saoirse.")
        }
        return try JSONDecoder().decode(Self.self, from: data)
    }

    func save() throws {
        let changes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(self),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var status = SecItemUpdate(Self.query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(Self.query.merging(changes) { _, value in value } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CompanionError.message("Couldn’t save the pairing to Keychain.") }
    }

    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CompanionError.message("Couldn’t remove the pairing from Keychain.")
        }
    }
}

enum CompanionError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): text }
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct RobotStatus: Decodable {
    let online: Bool
    let lastSeen: Date?
    var volume: Int?
    var brightness: Int?
    var directionsId: String?

    private enum CodingKeys: String, CodingKey { case online, lastSeen, volume, brightness, directionsId }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        online = try values.decode(Bool.self, forKey: .online)
        lastSeen = try values.decodeIfPresent(Date.self, forKey: .lastSeen)
        func percentage(_ key: CodingKeys) -> Int? {
            guard let value = try? values.decode(Int.self, forKey: key), (0...100).contains(value) else { return nil }
            return value
        }
        volume = percentage(.volume)
        brightness = percentage(.brightness)
        directionsId = try? values.decode(String.self, forKey: .directionsId)
    }
}

struct RobotReadback {
    private(set) var status: RobotStatus?
    private(set) var revision = 0

    mutating func reset(to status: RobotStatus?) {
        revision += 1
        self.status = status
    }

    @discardableResult
    mutating func accept(_ current: RobotStatus, requestedAt revision: Int) -> Bool {
        guard revision == self.revision else { return false }
        if let seen = current.lastSeen, let prior = status?.lastSeen, seen < prior { return false }
        status = current
        return true
    }

    mutating func acknowledge(_ action: String, data: Data) throws {
        revision += 1
        if data.isEmpty {
            // Older relays acknowledge a write without reporting its applied percentage.
            if action == "volume" { status?.volume = nil }
            else if action == "brightness" { status?.brightness = nil }
        } else {
            var report: RobotStatus = try CompanionClient.decode(data)
            // A level acknowledgment can omit the separate directions handoff.
            if report.directionsId == nil { report.directionsId = status?.directionsId }
            accept(report, requestedAt: revision)
        }
    }
}

struct RobotCommand: Encodable {
    let action: String
    var yaw: Int? = nil
    var pitch: Int? = nil
    var value: Int? = nil
}

struct HeadPosition: Equatable {
    static let center = HeadPosition(yaw: 0, pitch: 0)
    static let yawRange = -45...45
    static let pitchRange = 0...45

    let yaw: Int
    let pitch: Int

    var command: RobotCommand { .init(action: "head", yaw: yaw, pitch: pitch) }

    func moved(yawBy: Int, pitchBy: Int) -> HeadPosition {
        HeadPosition(
            yaw: min(Self.yawRange.upperBound, max(Self.yawRange.lowerBound, yaw + yawBy)),
            pitch: min(Self.pitchRange.upperBound, max(Self.pitchRange.lowerBound, pitch + pitchBy))
        )
    }
}

struct AIProfile: Codable {
    var name: String
    var backend: String
    var model: String
    var voiceId: String
    var voiceModel: String
    var gain: Double
    var persona: String
}

struct ProfileArchive: Decodable {
    let defaults: AIProfile
    let active: String?
    let profiles: [SavedProfile]
    let backends: [String]
}

struct SavedProfile: Decodable, Identifiable {
    let id: String
    let savedAt: Date
    let profile: AIProfile
}

struct ConversationPage: Decodable {
    let recording: Bool
    let turns: [ConversationTurn]
    let next: Int?
}

struct ConversationTurn: Decodable, Identifiable {
    let id: Int
    let session: String
    let at: Date
    let user: String
    let reply: String
}

struct ActiveProfile: Encodable {
    let id: String?
    func encode(to encoder: Encoder) throws {
        var value = encoder.container(keyedBy: CodingKeys.self)
        if let id { try value.encode(id, forKey: .id) }
        else { try value.encodeNil(forKey: .id) }
    }
    private enum CodingKeys: String, CodingKey { case id }
}

struct ArchiveSetting: Encodable {
    let recording: Bool
}

struct CompanionClient: Equatable {
    let pairing: Pairing

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 16
        configuration.timeoutIntervalForResource = 20
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
    }()

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let data = try await request(path, query: query)
        return try Self.decode(data)
    }

    static func decode<T: Decodable>(_ data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        do { return try decoder.decode(T.self, from: data) }
        catch { throw CompanionError.message("The relay sent an unexpected response. Check its version.") }
    }

    func send(_ path: String, method: String, body: some Encodable) async throws -> Data {
        try await request(path, method: method, body: JSONEncoder().encode(body))
    }

    func delete(_ path: String, query: [URLQueryItem] = []) async throws {
        _ = try await request(path, method: "DELETE", query: query)
    }

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [],
                         body: Data? = nil) async throws -> Data {
        var url = pairing.server.appending(path: "api/companion/\(path)")
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CompanionError.message("The relay didn’t return a response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            struct APIError: Decodable { let error: String }
            if let message = try? JSONDecoder().decode(APIError.self, from: data).error {
                throw CompanionError.message(message)
            }
            let message = http.statusCode == 404 ? "This relay doesn’t have the companion service." :
                "The relay returned HTTP \(http.statusCode)."
            throw CompanionError.message(message)
        }
        return data
    }
}

@MainActor @Observable
final class CompanionState {
    private(set) var pairing: Pairing?
    private var readback = RobotReadback()
    private(set) var connectionProblem: String?
    private(set) var lastHeadPosition: HeadPosition?

    var status: RobotStatus? { readback.status }
    var client: CompanionClient? { pairing.map(CompanionClient.init) }
    var online: Bool { status?.online == true && connectionProblem == nil }
    var connectionLabel: String {
        if pairing == nil { return "Pair Saoirse" }
        if connectionProblem != nil { return "Relay unreachable" }
        guard let status else { return "Checking connection…" }
        return status.online ? "Saoirse is online" : "Saoirse is offline"
    }

    init() {
        do { pairing = try Pairing.load() }
        catch { connectionProblem = error.localizedDescription }
    }

    func pair(_ candidate: Pairing) async throws {
        let revision = readback.revision
        let result: RobotStatus = try await CompanionClient(pairing: candidate).get("status")
        try Task.checkCancellation()
        try candidate.save()
        if pairing == candidate {
            readback.accept(result, requestedAt: revision)
        } else {
            lastHeadPosition = nil
            readback.reset(to: result)
        }
        connectionProblem = nil
        pairing = candidate
    }

    func unpair() throws {
        try Pairing.remove()
        pairing = nil
        readback.reset(to: nil)
        connectionProblem = nil
        lastHeadPosition = nil
    }

    func sendControl(_ command: RobotCommand, using client: CompanionClient) async throws {
        let data = try await client.send("command", method: "POST", body: command)
        guard self.client == client else { return }
        if command.action == "head", let yaw = command.yaw, let pitch = command.pitch {
            lastHeadPosition = HeadPosition(yaw: yaw, pitch: pitch)
        } else if command.action == "volume" || command.action == "brightness" {
            try readback.acknowledge(command.action, data: data)
            connectionProblem = nil
        }
    }

    func monitor() async {
        guard let client else { return }
        while !Task.isCancelled && self.client == client {
            let revision = readback.revision
            do {
                let current: RobotStatus = try await client.get("status")
                try Task.checkCancellation()
                guard self.client == client else { return }
                if readback.accept(current, requestedAt: revision) { connectionProblem = nil }
            } catch {
                guard !Task.isCancelled, self.client == client else { return }
                if revision == readback.revision { connectionProblem = error.localizedDescription }
            }
            try? await Task.sleep(for: .seconds(4))
        }
    }
}
