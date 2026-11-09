// How `openagentd_keychain_set` (KeychainBridge.swift) writes an item,
// apart from the Keychain calls themselves so it can be tested on macOS
// (`ios-widget/tests/run-swift-checks.sh`).

import Foundation
import Security

enum KeychainWrite {
    /// Updates the item in place, and adds it only when it is missing. Any
    /// other failure returns as is: nothing was deleted, so the value
    /// already stored stays.
    static func upsert(update: () -> OSStatus, add: () -> OSStatus) -> OSStatus {
        let status = update()
        return status == errSecItemNotFound ? add() : status
    }
}
