// The phone's OpenAgentd Cloud keys in the iOS Keychain, for the Rust shell
// (`mobile/src-tauri/src/cloud.rs`). Compiled into the app target by
// `scripts/patch-ios-widget.sh`.
//
// Three items, each a short UTF-8 string (`appv3/contract/tunnel-threats.md`,
// "Storage"):
//
// * `identity`: the device's auth and box seeds, account id and last
//   verified roster. This device only, readable after first unlock.
// * `box`: the box seed alone, in the App Group's keychain access group so
//   the Notification Service Extension can open sealed notifications while
//   the phone is locked (after first unlock). This device only.
// * `sign`: the seed that signs rosters. Reading it needs Face ID, Touch ID
//   or the passcode (`.userPresence`), so approving or removing a device
//   always asks. This device only; never synced, never backed up.
//
// Every function is synchronous and may block on the Face ID prompt: the
// Rust side calls them off the main thread.

import Foundation
import LocalAuthentication
import Security

private let service = "dev.openagentd.cloud"

/// The App Group, shared with the Notification Service Extension. Its name
/// works as a keychain access group for every target that has the group.
private func appGroup() -> String? {
    if let group = Bundle.main.infoDictionary?["OAWidgetAppGroup"] as? String,
       !group.isEmpty, !group.contains("$(") {
        return group
    }
    return Bundle.main.bundleIdentifier.map { "group.\($0)" }
}

/// 0: identity (this app), 1: box (shared with the extension), 2: sign
/// (user presence). Anything else is refused.
private func baseQuery(_ item: Int32) -> [String: Any]? {
    var q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecUseDataProtectionKeychain as String: true,
    ]
    switch item {
    case 0: q[kSecAttrAccount as String] = "identity"
    case 1:
        q[kSecAttrAccount as String] = "box"
        guard let group = appGroup() else { return nil }
        q[kSecAttrAccessGroup as String] = group
    case 2: q[kSecAttrAccount as String] = "sign"
    default: return nil
    }
    return q
}

/// Stores an item. Returns an `OSStatus` (0: stored).
///
/// `identity` and `box` are updated in place and added only when missing
/// (`KeychainWrite.upsert`), so a failed write keeps the stored value.
/// `sign` is written only for brand-new keys (`finish` in
/// `mobile/src-tauri/src/cloud.rs`, before `identity`): an item already
/// there belongs to keys being replaced, and updating an item that needs
/// user presence would ask for Face ID, so that one is deleted and added.
@_cdecl("openagentd_keychain_set")
public func openagentdKeychainSet(_ item: Int32, _ value: UnsafePointer<CChar>) -> Int32 {
    guard var q = baseQuery(item) else { return -50 }
    let data = Data(String(cString: value).utf8)
    if item == 2 {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error
        ) else { return -50 }
        SecItemDelete(q as CFDictionary)
        q[kSecAttrAccessControl as String] = access
        q[kSecValueData as String] = data
        return SecItemAdd(q as CFDictionary, nil)
    }
    let attributes: [String: Any] = [
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    return KeychainWrite.upsert(
        update: { SecItemUpdate(q as CFDictionary, attributes as CFDictionary) },
        add: { SecItemAdd(q.merging(attributes) { $1 } as CFDictionary, nil) }
    )
}

/// Reads an item into `*out` (free it with `openagentd_keychain_free`).
/// Returns 0, or -25300 (`errSecItemNotFound`), -128 (cancelled), or
/// another `OSStatus`. `reason` is the line Face ID shows for the sign key.
@_cdecl("openagentd_keychain_get")
public func openagentdKeychainGet(
    _ item: Int32, _ reason: UnsafePointer<CChar>?, _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> Int32 {
    out.pointee = nil
    guard var q = baseQuery(item) else { return -50 }
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    if item == 2 {
        let context = LAContext()
        context.localizedReason = reason.map { String(cString: $0) } ?? "Approve with your account key"
        q[kSecUseAuthenticationContext as String] = context
    }
    var result: AnyObject?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess else { return status == errSecUserCanceled ? -128 : status }
    guard let data = result as? Data, let text = String(data: data, encoding: .utf8) else { return -26276 }
    out.pointee = strdup(text)
    return 0
}

@_cdecl("openagentd_keychain_free")
public func openagentdKeychainFree(_ p: UnsafeMutablePointer<CChar>?) {
    guard let p = p else { return }
    memset(p, 0, strlen(p))
    free(p)
}

@_cdecl("openagentd_keychain_delete")
public func openagentdKeychainDelete(_ item: Int32) -> Int32 {
    guard let q = baseQuery(item) else { return -50 }
    let status = SecItemDelete(q as CFDictionary)
    return status == errSecItemNotFound ? 0 : status
}

/// Writes (or, given nil, deletes) `cloud-push.json` in the App Group: the
/// account id, this phone's device id and its computers' public box keys,
/// which the Notification Service Extension needs to open letters. Not
/// secret; complete protection until first unlock, like the Keychain items.
@_cdecl("openagentd_cloud_push_context")
public func openagentdCloudPushContext(_ json: UnsafePointer<CChar>?) -> Bool {
    guard let group = appGroup(),
          let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { return false }
    let url = dir.appendingPathComponent("cloud-push.json")
    guard let json = json else {
        try? FileManager.default.removeItem(at: url)
        return true
    }
    do {
        try Data(String(cString: json).utf8).write(
            to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        return true
    } catch {
        return false
    }
}
