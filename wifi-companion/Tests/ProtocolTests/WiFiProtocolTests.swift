import XCTest
@testable import StackChanWiFiProtocol

final class WiFiProtocolTests: XCTestCase {
    func testCredentialsPreserveWhitespaceUnicodeAndEscapes() throws {
        let password = " p\"a\\ss🔑 "
        let data = try WiFiProtocol.configuration(ssid: " Café ", password: password)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let credentials = try XCTUnwrap(object["data"] as? [String: String])
        XCTAssertEqual(object["cmd"] as? String, "setWifi")
        XCTAssertEqual(credentials, ["ssid": " Café ", "password": password])
    }

    func testFirmwareCredentialBoundaries() throws {
        XCTAssertNoThrow(try WiFiProtocol.configuration(ssid: String(repeating: "a", count: 32), password: ""))
        XCTAssertNoThrow(try WiFiProtocol.configuration(ssid: "WiFi", password: String(repeating: "a", count: 64)))
        for ssid in ["", String(repeating: "a", count: 33), String(repeating: "é", count: 17), "bad\0name"] {
            XCTAssertThrowsError(try WiFiProtocol.configuration(ssid: ssid, password: ""))
        }
        for password in [String(repeating: "a", count: 65), "bad\0password"] {
            XCTAssertThrowsError(try WiFiProtocol.configuration(ssid: "WiFi", password: password))
        }
    }

    func testRawAndFragmentedRoundTripsAcrossMTUs() throws {
        let payload = try WiFiProtocol.configuration(ssid: "ネットワーク", password: String(repeating: "p", count: 64))
        for limit in [20, 23, 69, 182, 244, 512] {
            let packets = try WiFiProtocol.packets(for: payload, maximumWriteLength: limit)
            var assembler = WiFiPacketAssembler()
            var complete: Data?
            for packet in packets {
                XCTAssertLessThanOrEqual(packet.count, limit)
                complete = try assembler.consume(packet)
            }
            XCTAssertEqual(complete, payload)
        }
    }

    func testMissingOrOutOfOrderPacketIsRejectedAndNextMessageRecovers() throws {
        let payload = Data(repeating: 65, count: 60)
        let packets = try WiFiProtocol.packets(for: payload, maximumWriteLength: 20)
        var assembler = WiFiPacketAssembler()
        XCTAssertThrowsError(try assembler.consume(packets[1]))
        XCTAssertNil(try assembler.consume(packets[0]))
        XCTAssertThrowsError(try assembler.consume(packets[2]))
        var result: Data?
        for packet in packets { result = try assembler.consume(packet) }
        XCTAssertEqual(result, payload)
    }

    func testExpiredFragmentsCannotCompleteAnOldResponse() throws {
        let packets = try WiFiProtocol.packets(for: Data(repeating: 65, count: 30), maximumWriteLength: 20)
        var assembler = WiFiPacketAssembler()
        let now = Date()
        XCTAssertNil(try assembler.consume(packets[0], now: now))
        XCTAssertThrowsError(try assembler.consume(packets[1], now: now.addingTimeInterval(3)))
    }

    func testTruncatedAndOversizedPacketsAreRejected() throws {
        var assembler = WiFiPacketAssembler()
        XCTAssertThrowsError(try assembler.consume(Data(WiFiProtocol.magic)))
        XCTAssertThrowsError(try assembler.consume(Data(repeating: 1, count: 2049)))
        XCTAssertThrowsError(try WiFiProtocol.packets(for: Data(repeating: 1, count: 2049), maximumWriteLength: 20))
        XCTAssertThrowsError(try WiFiProtocol.packets(for: Data(repeating: 1, count: 50), maximumWriteLength: 10))
    }

    func testActualFirmwareStatusFormats() throws {
        let connected = Data(#"{"cmd":"notifyState","data":{"type":1,"state":"wifiConnected"}}"#.utf8)
        XCTAssertEqual(try WiFiProtocol.status(from: connected).state, "wifiConnected")
        let failed = Data(#"{"cmd":"notifyState","data":{"type":2,"state":"wifiConnectFailed","errorCode":"dhcp_timeout","errorMessage":"No IP address assigned."}}"#.utf8)
        XCTAssertEqual(try WiFiProtocol.status(from: failed).errorCode, "dhcp_timeout")
        XCTAssertThrowsError(try WiFiProtocol.status(from: Data(#"{"cmd":"other","data":{"type":1,"state":"wifiConnected"}}"#.utf8)))
    }
}
