import CoreBluetooth
import Foundation
import Observation

struct NearbyStackChan: Identifiable {
    let id: UUID
    var name: String
    var deviceID: String?
    var alreadyConnected: Bool
}

@MainActor @Observable
final class StackChanBluetooth: NSObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    enum Phase: Equatable { case idle, scanning, connecting, ready, verifying, success, failed }

    private(set) var devices: [NearbyStackChan] = []
    private(set) var selectedID: UUID?
    private(set) var phase: Phase = .idle
    private(set) var message = "Open Change Wi-Fi on your StackChan, then find it below."
    private(set) var canConfigure = false
    private(set) var connectedSSID = ""
    private(set) var permissionDenied = false

    private let setupService = CBUUID(string: "e2e5e5ff-1234-5678-1234-56789abcdef0")
    private let configUUID = CBUUID(string: "e2e5e5e3-1234-5678-1234-56789abcdef0")
    private var central: CBCentralManager!
    private var peripherals: [UUID: CBPeripheral] = [:]
    private var advertisements: [UUID: [String: Any]] = [:]
    private var target: CBPeripheral?
    private var characteristic: CBCharacteristic?
    private var assembler = WiFiPacketAssembler()
    private var outgoing: [Data] = []
    private var writing = false
    private var awaitingWiFi = false
    private var operationTimeout: DispatchWorkItem?
    private var scanTimeout: DispatchWorkItem?
    private var statusPoll: DispatchWorkItem?
    private var requestedSSID = ""

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    var isBusy: Bool { phase == .connecting || phase == .verifying }

    func findDevices() {
        guard !isBusy else { return }
        guard central.state == .poweredOn else {
            centralManagerDidUpdateState(central)
            return
        }
        phase = .scanning
        message = "Looking for StackChan devices ready for Wi-Fi setup…"
        permissionDenied = false
        devices = []
        // Connected peripherals stop advertising. Recover them from iOS as
        // well as scanning, including peripherals connected by the official app.
        for peripheral in central.retrieveConnectedPeripherals(withServices: [setupService]) {
            record(peripheral, advertisement: advertisements[peripheral.identifier] ?? [:], connected: true)
        }
        central.stopScan()
        central.scanForPeripherals(withServices: [setupService], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        scanTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.phase == .scanning else { return }
            self.central.stopScan()
            self.phase = .idle
            self.message = self.devices.isEmpty
                ? "No StackChan found. On the robot, open Settings → Wi-Fi → Change Wi-Fi, then tap Next. If another phone is connected, close its StackChan app."
                : "Choose your StackChan below."
        }
        scanTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
    }

    func select(_ device: NearbyStackChan) {
        guard !isBusy, let peripheral = peripherals[device.id] else { return }
        let connectedLocally = target?.identifier == device.id && peripheral.state == .connected
        operationTimeout?.cancel()
        statusPoll?.cancel()
        scanTimeout?.cancel()
        central.stopScan()
        if let previous = target, previous.identifier != device.id {
            central.cancelPeripheralConnection(previous)
        }
        clearTransport()
        target = peripheral
        selectedID = device.id
        peripheral.delegate = self
        phase = .connecting
        message = "Connecting to \(device.name)…"
        armTimeout(seconds: 25, message: "Bluetooth setup timed out. Tap Find StackChan and try again.")
        // Even a system-connected peripheral must be connected to this client.
        if connectedLocally { peripheral.discoverServices([setupService]) }
        else { central.connect(peripheral) }
    }

    func configure(ssid: String, password: String) {
        guard canConfigure, !isBusy else { return }
        do {
            let payload = try WiFiProtocol.configuration(ssid: ssid, password: password)
            guard let target, let characteristic, target.state == .connected, characteristic.isNotifying else {
                fail("Bluetooth disconnected. Find your StackChan and reconnect.")
                return
            }
            outgoing += try WiFiProtocol.packets(for: payload, maximumWriteLength: min(200, target.maximumWriteValueLength(for: .withResponse)))
            requestedSSID = ssid
            awaitingWiFi = true
            connectedSSID = ""
            phase = .verifying
            message = "StackChan is checking \(ssid)…"
            armTimeout(seconds: 40, message: "No connection confirmation arrived. Keep StackChan nearby, check its screen, and try again.")
            writeNext()
        } catch {
            fail(error.localizedDescription)
        }
    }

    func disconnect() {
        operationTimeout?.cancel()
        statusPoll?.cancel()
        scanTimeout?.cancel()
        central.stopScan()
        let previous = target
        target = nil
        selectedID = nil
        clearTransport()
        if let previous { central.cancelPeripheralConnection(previous) }
        phase = .idle
        message = "Open Change Wi-Fi on your StackChan, then find it below."
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        permissionDenied = central.state == .unauthorized
        if central.state == .poweredOn {
            if target == nil { findDevices() }
            return
        }
        operationTimeout?.cancel()
        statusPoll?.cancel()
        scanTimeout?.cancel()
        target = nil
        selectedID = nil
        devices = []
        clearTransport()
        phase = .failed
        switch central.state {
        case .unauthorized: message = "Allow Bluetooth access in iPhone Settings to find StackChan."
        case .poweredOff: message = "Turn on Bluetooth in iPhone Settings, then try again."
        case .unsupported: message = "Bluetooth Low Energy is unavailable on this device."
        default: message = "Bluetooth is starting. Keep this app open."
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        record(peripheral, advertisement: advertisementData, connected: peripheral.state == .connected)
    }

    private func record(_ peripheral: CBPeripheral, advertisement: [String: Any], connected: Bool) {
        peripherals[peripheral.identifier] = peripheral
        var merged = advertisements[peripheral.identifier] ?? [:]
        merged.merge(advertisement) { _, new in new }
        advertisements[peripheral.identifier] = merged
        let bytes = [UInt8](merged[CBAdvertisementDataManufacturerDataKey] as? Data ?? Data())
        let factoryID = bytes.count == 8 && bytes[0] == 0xE5 && bytes[1] == 0x02
            ? bytes.dropFirst(2).map { String(format: "%02X", $0) }.joined(separator: ":") : nil
        let name = merged[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? "StackChan"
        let device = NearbyStackChan(id: peripheral.identifier, name: name.isEmpty ? "StackChan" : name, deviceID: factoryID, alreadyConnected: connected)
        if let index = devices.firstIndex(where: { $0.id == device.id }) { devices[index] = device }
        else { devices.append(device) }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == target?.identifier else { return }
        peripheral.delegate = self
        message = "Opening StackChan’s Wi-Fi setup…"
        peripheral.discoverServices([setupService])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == target?.identifier else { return }
        clearTransport()
        fail("Could not connect to StackChan. Keep it nearby and tap Find StackChan to retry.")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier == target?.identifier else { return }
        clearTransport()
        operationTimeout?.cancel()
        statusPoll?.cancel()
        if phase != .success && phase != .failed { fail("StackChan disconnected. If it rebooted, check its screen before retrying.") }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral.identifier == target?.identifier else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == setupService }) else {
            fail("Open Settings → Wi-Fi → Change Wi-Fi on StackChan and tap Next, then reconnect.")
            return
        }
        peripheral.discoverCharacteristics([configUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral.identifier == target?.identifier else { return }
        guard error == nil, let config = service.characteristics?.first(where: { $0.uuid == configUUID }),
              config.properties.contains(.write), config.properties.contains(.notify) else {
            fail("StackChan’s Wi-Fi setup service is unavailable. Reopen Change Wi-Fi on the robot.")
            return
        }
        characteristic = config
        peripheral.setNotifyValue(true, for: config)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral.identifier == target?.identifier, characteristic.uuid == configUUID else { return }
        guard error == nil, characteristic.isNotifying else {
            fail("Could not receive StackChan’s status. Reconnect and try again.")
            return
        }
        operationTimeout?.cancel()
        canConfigure = true
        phase = .ready
        message = "Connected to StackChan. Enter the new Wi-Fi details below."
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral.identifier == target?.identifier, characteristic.uuid == configUUID else { return }
        writing = false
        guard error == nil else {
            outgoing = []
            fail("Could not send the Wi-Fi settings. Reconnect and try again.")
            return
        }
        writeNext()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral.identifier == target?.identifier, characteristic.uuid == configUUID else { return }
        guard error == nil, let value = characteristic.value else { return }
        do {
            guard let payload = try assembler.consume(value) else { return }
            let status = try WiFiProtocol.status(from: payload)
            guard awaitingWiFi else { return }
            switch status.state {
            case "wifiConnected" where status.type == 1:
                awaitingWiFi = false
                operationTimeout?.cancel()
                statusPoll?.cancel()
                connectedSSID = requestedSSID
                UserDefaults.standard.set(requestedSSID, forKey: "lastSSID")
                phase = .success
                message = "StackChan connected to \(requestedSSID). It will restart automatically."
            case "wifiConnectFailed":
                fail(status.errorMessage ?? "StackChan could not connect. Check the Wi-Fi name and password and use a 2.4 GHz network.")
            default: break
            }
        } catch {
            // A later status poll can recover from an incomplete notification;
            // never interpret a partial or invalid response as success.
            assembler.reset()
        }
    }

    private func requestStatus() {
        guard canConfigure else { return }
        outgoing.append(Data(#"{"cmd":"getWifiStatus"}"#.utf8))
        writeNext()
    }

    private func writeNext() {
        guard !writing, let target, let characteristic, target.state == .connected else { return }
        guard !outgoing.isEmpty else {
            if awaitingWiFi { scheduleStatusPoll() }
            return
        }
        writing = true
        target.writeValue(outgoing.removeFirst(), for: characteristic, type: .withResponse)
    }

    private func scheduleStatusPoll() {
        statusPoll?.cancel()
        let poll = DispatchWorkItem { [weak self] in
            guard let self, self.awaitingWiFi else { return }
            self.requestStatus()
        }
        statusPoll = poll
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: poll)
    }

    private func armTimeout(seconds: Double, message: String) {
        operationTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.fail(message)
            if let target = self.target { self.central.cancelPeripheralConnection(target) }
        }
        operationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: timeout)
    }

    private func fail(_ reason: String) {
        operationTimeout?.cancel()
        statusPoll?.cancel()
        awaitingWiFi = false
        outgoing = []
        phase = .failed
        message = reason
    }

    private func clearTransport() {
        canConfigure = false
        characteristic = nil
        outgoing = []
        writing = false
        awaitingWiFi = false
        assembler.reset()
    }
}
