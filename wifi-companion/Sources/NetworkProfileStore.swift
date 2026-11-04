import Foundation
import Observation
import Security

@MainActor @Observable
final class NetworkProfileStore {
    private(set) var profiles = NetworkProfile.presets
    private(set) var savedIDs: Set<String> = []
    var errorMessage: String?
    private let service = "com.uscabayao.StackChanWiFi.networks"

    init() {
        for index in profiles.indices {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: profiles[index].id,
                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { continue }
            guard status == errSecSuccess, let data = result as? Data,
                  let profile = try? JSONDecoder().decode(NetworkProfile.self, from: data),
                  profile.id == profiles[index].id else {
                errorMessage = "A saved network could not be read from Keychain. Unlock your iPhone and reopen the app."
                continue
            }
            profiles[index] = profile
            savedIDs.insert(profile.id)
        }
    }

    func save(_ profile: NetworkProfile) throws {
        _ = try profile.configuration()
        let data = try JSONEncoder().encode(profile)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: profile.id]
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) { profiles[index] = profile }
        savedIDs.insert(profile.id)
    }

    func forget(_ profile: NetworkProfile) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: profile.id]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
        if let index = profiles.firstIndex(where: { $0.id == profile.id }),
           let original = NetworkProfile.presets.first(where: { $0.id == profile.id }) { profiles[index] = original }
        savedIDs.remove(profile.id)
    }
}

private struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Could not update the iPhone Keychain (\(status)). Your network details were not saved." }
}
