import Foundation

// Run from companion/ios:
// swiftc Sources/Protocol/Directions.swift Tests/DirectionsTests.swift -o /tmp/directions-test && /tmp/directions-test
@main
enum DirectionsTests {
    static func main() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        func sample(_ mode: String, geometry: [[Double]] = []) throws -> CompanionRoute {
            let route: [String: Any] = [
                "id": "sample", "createdAt": 1_700_000_000_000, "expiresAt": 1_700_000_600_000,
                "origin": "A & B + C", "destination": "Station #2", "mode": mode,
                "durationMinutes": 12, "steps": [["instruction": "Walk along the path"]],
                "geometry": geometry, "source": "Fixture"
            ]
            let data = try JSONSerialization.data(withJSONObject: ["route": route])
            return try decoder.decode(DirectionsResponse.self, from: data).route!
        }
        func query(_ link: CompanionRoute.MapLink) -> [String: String] {
            let items = URLComponents(url: link.url, resolvingAgainstBaseURL: false)!.queryItems!
            return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
        }
        let empty = try decoder.decode(DirectionsResponse.self, from: Data(#"{"route":null}"#.utf8))
        precondition(empty.route == nil)
        for (mode, flag) in [("walk", "w"), ("drive", "d"), ("transit", "r")] {
            let route = try sample(mode)
            let url = route.mapLink(unifiedAppleMaps: false)!
            precondition(url.url.host == "maps.apple.com" && query(url)["dirflg"] == flag)
            precondition(query(url)["saddr"] == "A & B + C" && query(url)["daddr"] == "Station #2")
            precondition(url.url.absoluteString.contains("%2B") && route.path.isEmpty)
            precondition(route.expiresAt.timeIntervalSince(route.createdAt) == 600)
        }
        let cycling = try sample("cycle", geometry: [[51.5, -0.1], [51.6, -0.2]])
        precondition(cycling.path.count == 2 && cycling.steps.first?.instruction == "Walk along the path")
        let modern = cycling.mapLink(unifiedAppleMaps: true)!
        precondition(modern.url.path == "/directions" && query(modern)["mode"] == "cycling")
        precondition(query(modern)["source"] == "51.5,-0.1" && query(modern)["destination"] == "51.6,-0.2")
        let older = cycling.mapLink(unifiedAppleMaps: false)!
        precondition(older.url.host == "www.google.com" && query(older)["travelmode"] == "bicycling")
        precondition(query(older)["api"] == "1" && query(older)["origin"] == "51.5,-0.1")
        let malformed = try sample("walk", geometry: [[51.5, 0], [99, -1], [51.6, 0]])
        precondition(malformed.path.isEmpty)
        print("Route decode, geometry and Maps handoff regression checks passed.")
    }
}
