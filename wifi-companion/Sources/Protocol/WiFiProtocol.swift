import Foundation

enum WiFiProtocolError: LocalizedError {
    case invalidSSID, invalidPassword, invalidPacketSize, invalidFragment

    var errorDescription: String? {
        switch self {
        case .invalidSSID: return "Enter a Wi-Fi name containing 1–32 bytes."
        case .invalidPassword: return "The Wi-Fi password must be at most 64 bytes and contain no NUL characters."
        case .invalidPacketSize: return "Bluetooth cannot send this configuration. Reconnect and try again."
        case .invalidFragment: return "An incomplete Bluetooth message was received. Reconnect and try again."
        }
    }
}

struct WiFiStatus: Decodable {
    let type: Int
    let state: String
    let errorCode: String?
    let errorMessage: String?
}

enum WiFiProtocol {
    static let maximumLength = 2048
    static let headerLength = 10
    static let magic: [UInt8] = [0xAA, 0x55, 0xC3, 1]

    static func configuration(ssid: String, password: String) throws -> Data {
        guard (1...32).contains(ssid.utf8.count), !ssid.contains("\0") else {
            throw WiFiProtocolError.invalidSSID
        }
        guard password.utf8.count <= 64, !password.contains("\0") else {
            throw WiFiProtocolError.invalidPassword
        }
        return try JSONSerialization.data(withJSONObject: [
            "cmd": "setWifi", "data": ["ssid": ssid, "password": password],
        ])
    }

    static func packets(for payload: Data, maximumWriteLength limit: Int) throws -> [Data] {
        guard !payload.isEmpty, payload.count <= maximumLength, limit > 0 else {
            throw WiFiProtocolError.invalidPacketSize
        }
        if payload.count <= limit { return [payload] }
        let chunkSize = limit - headerLength
        guard chunkSize > 0 else { throw WiFiProtocolError.invalidPacketSize }
        let count = (payload.count + chunkSize - 1) / chunkSize
        return (0..<count).map { index in
            var packet = Data(magic + [
                UInt8(index >> 8), UInt8(index & 255), UInt8(count >> 8), UInt8(count & 255),
                UInt8(payload.count >> 8), UInt8(payload.count & 255),
            ])
            packet.append(payload.subdata(in: index * chunkSize..<min(payload.count, (index + 1) * chunkSize)))
            return packet
        }
    }

    static func status(from payload: Data) throws -> WiFiStatus {
        struct Notification: Decodable { let cmd: String; let data: WiFiStatus }
        let message = try JSONDecoder().decode(Notification.self, from: payload)
        guard message.cmd == "notifyState" else { throw WiFiProtocolError.invalidFragment }
        return message.data
    }
}

struct WiFiPacketAssembler {
    private var buffer = Data()
    private var nextIndex = 0
    private var expectedPackets = 0
    private var expectedLength = 0
    private var lastPacket = Date.distantPast

    mutating func reset() {
        buffer = Data()
        nextIndex = 0
        expectedPackets = 0
        expectedLength = 0
        lastPacket = .distantPast
    }

    mutating func consume(_ packet: Data, now: Date = Date()) throws -> Data? {
        let bytes = [UInt8](packet)
        guard bytes.count >= 4, Array(bytes.prefix(4)) == WiFiProtocol.magic else {
            reset()
            guard !packet.isEmpty, packet.count <= WiFiProtocol.maximumLength else {
                throw WiFiProtocolError.invalidFragment
            }
            return packet
        }
        guard bytes.count > WiFiProtocol.headerLength else {
            reset()
            throw WiFiProtocolError.invalidFragment
        }
        let index = Int(bytes[4]) << 8 | Int(bytes[5])
        let count = Int(bytes[6]) << 8 | Int(bytes[7])
        let length = Int(bytes[8]) << 8 | Int(bytes[9])
        if index == 0 {
            reset()
            expectedPackets = count
            expectedLength = length
        } else if now.timeIntervalSince(lastPacket) > 2 {
            reset()
            throw WiFiProtocolError.invalidFragment
        }
        guard count > 0, index < count, index == nextIndex,
              count == expectedPackets, length == expectedLength,
              (1...WiFiProtocol.maximumLength).contains(length),
              buffer.count + bytes.count - WiFiProtocol.headerLength <= length else {
            reset()
            throw WiFiProtocolError.invalidFragment
        }
        buffer.append(contentsOf: bytes.dropFirst(WiFiProtocol.headerLength))
        nextIndex += 1
        lastPacket = now
        if nextIndex == count {
            guard buffer.count == length else {
                reset()
                throw WiFiProtocolError.invalidFragment
            }
            let complete = buffer
            reset()
            return complete
        }
        guard buffer.count < length else {
            reset()
            throw WiFiProtocolError.invalidFragment
        }
        return nil
    }
}
