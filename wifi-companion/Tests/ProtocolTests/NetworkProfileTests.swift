import XCTest
@testable import StackChanWiFiProtocol

final class NetworkProfileTests: XCTestCase {
    func testUCLCredentialsUseEnterpriseInsteadOfSharedPassword() throws {
        let profile = NetworkProfile(id: "eduroam", ssid: "eduroam", password: "example-only", username: "abc123@ucl.ac.uk", security: .uclEduroam)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: profile.configuration()) as? [String: Any])
        let fields = try XCTUnwrap(object["data"] as? [String: Any])
        XCTAssertEqual(fields["security"] as? String, "ucl-eduroam")
        XCTAssertEqual(fields["username"] as? String, "abc123@ucl.ac.uk")
        XCTAssertEqual(fields["ssid"] as? String, "eduroam")
    }
    func testEnterpriseCannotSendMissingOrWrongRealmIdentity() {
        for username in ["", "abc123", "abc123@example.org", "abc\0@ucl.ac.uk"] {
            let profile = NetworkProfile(id: "eduroam", ssid: "eduroam", password: "example-only", username: username, security: .uclEduroam)
            XCTAssertThrowsError(try profile.configuration())
        }
    }
    func testPresetPasswordsAreNotInventedAndPSKRemainsCompatible() throws {
        XCTAssertEqual(NetworkProfile.presets.map(\.ssid), ["Saoirse", "ClaphamSJ", "Christs-IoT", "eduroam"])
        XCTAssertTrue(NetworkProfile.presets.allSatisfy { $0.password.isEmpty })
        let profile = NetworkProfile(id: "ClaphamSJ", ssid: "ClaphamSJ", password: "example-only")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: profile.configuration()) as? [String: Any])
        XCTAssertEqual(object["data"] as? [String: String], ["ssid": "ClaphamSJ", "password": "example-only"])
    }
}
