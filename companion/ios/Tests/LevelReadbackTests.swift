import Foundation

// Run from companion/ios on macOS:
// xcrun swiftc Sources/CompanionClient.swift Tests/LevelReadbackTests.swift -o /tmp/level-readback && /tmp/level-readback
@main
enum LevelReadbackTests {
    static func main() throws {
        func snapshot(_ json: String) throws -> RobotStatus {
            try CompanionClient.decode(Data(json.utf8))
        }
        var readback = RobotReadback()
        let legacy = try snapshot(#"{"online":true,"lastSeen":100}"#)
        readback.reset(to: legacy)
        precondition(readback.status?.volume == nil && readback.status?.brightness == nil)

        let initial = try snapshot(#"{"online":true,"lastSeen":105,"volume":0,"brightness":100,"directionsId":"route-one"}"#)
        let pendingPoll = readback.revision
        precondition(readback.accept(initial, requestedAt: pendingPoll))
        precondition(readback.status?.volume == 0 && readback.status?.brightness == 100)

        let ack = Data(#"{"online":true,"lastSeen":110,"volume":37,"brightness":100}"#.utf8)
        try readback.acknowledge("volume", data: ack)
        precondition(readback.status?.directionsId == "route-one")
        // An older poll may arrive after the POST, including one sharing its millisecond.
        let tiedPoll = try snapshot(#"{"online":true,"lastSeen":110,"volume":0,"brightness":100}"#)
        precondition(!readback.accept(tiedPoll, requestedAt: pendingPoll))
        precondition(!readback.accept(initial, requestedAt: readback.revision))
        precondition(readback.status?.volume == 37)

        let external = try snapshot(#"{"online":true,"lastSeen":140,"volume":41,"brightness":0}"#)
        precondition(readback.accept(external, requestedAt: readback.revision))
        precondition(readback.status?.directionsId == nil)
        // A slower ACK cannot roll back a later physical adjustment.
        try readback.acknowledge("volume", data: ack)
        precondition(readback.status?.volume == 41 && readback.status?.brightness == 0)
        let beforeLegacyAck = readback.revision
        try readback.acknowledge("brightness", data: Data())
        precondition(!readback.accept(external, requestedAt: beforeLegacyAck))
        precondition(readback.status?.brightness == nil && readback.status?.volume == 41)

        let partial = try snapshot(#"{"online":true,"lastSeen":145,"volume":-2,"brightness":60}"#)
        precondition(readback.accept(partial, requestedAt: readback.revision))
        precondition(readback.status?.volume == nil && readback.status?.brightness == 60)
        let invalid = try snapshot(#"{"online":true,"lastSeen":146,"volume":"bad","brightness":101}"#)
        precondition(invalid.volume == nil && invalid.brightness == nil && invalid.online)
        let offline = try snapshot(#"{"online":false,"lastSeen":145,"volume":null,"brightness":60}"#)
        precondition(readback.accept(offline, requestedAt: readback.revision))
        precondition(readback.status?.online == false && readback.status?.brightness == 60)
        let oldPair = readback.revision
        readback.reset(to: nil)
        precondition(!readback.accept(external, requestedAt: oldPair) && readback.status == nil)
        print("Speaker and display readback regression checks passed.")
    }
}
