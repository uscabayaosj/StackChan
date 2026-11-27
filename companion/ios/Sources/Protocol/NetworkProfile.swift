import Foundation

struct NetworkProfile: Codable, Identifiable, Equatable {
    enum Security: String, Codable { case personal, uclEduroam }
    var id: String
    var ssid: String
    var password = ""
    var username = ""
    var security: Security = .personal

    static let presets = [
        NetworkProfile(id: "Saoirse", ssid: "Saoirse"),
        NetworkProfile(id: "ClaphamSJ", ssid: "ClaphamSJ"),
        NetworkProfile(id: "Christs-IoT", ssid: "Christs-IoT"),
        NetworkProfile(id: "eduroam", ssid: "eduroam", security: .uclEduroam),
    ]

    func configuration() throws -> Data {
        if security == .personal { return try WiFiProtocol.configuration(ssid: ssid, password: password) }
        guard ssid == "eduroam", username.hasSuffix("@ucl.ac.uk"),
              username.split(separator: "@", omittingEmptySubsequences: false).count == 2,
              username.utf8.count > 10, username.utf8.count <= 128,
              !username.contains("\0"), !username.contains(where: \.isWhitespace),
              !password.isEmpty, password.utf8.count <= 64, !password.contains("\0") else {
            throw ProfileError.invalidUCLCredentials
        }
        return try JSONSerialization.data(withJSONObject: ["cmd": "setWifi", "data": [
            "ssid": ssid, "password": password, "security": "ucl-eduroam", "username": username,
            "unixTime": Int64(Date().timeIntervalSince1970),
        ]])
    }
}

enum ProfileError: LocalizedError {
    case invalidUCLCredentials
    var errorDescription: String? { "Enter your UCL user ID followed by @ucl.ac.uk and your UCL password. Use your user ID, which may differ from your email address." }
}
