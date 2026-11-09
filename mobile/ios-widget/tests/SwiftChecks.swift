// Checks the Keychain write order and the Show Previews rule on macOS.
// Run by run-swift-checks.sh.

import Foundation
import Security
import UserNotifications

@main
struct SwiftChecks {
    static func check(_ ok: Bool, _ what: String) {
        if !ok {
            FileHandle.standardError.write(Data("FAIL: \(what)\n".utf8))
            exit(1)
        }
    }

    static func main() {
        var calls: [String] = []
        // A stored item is updated in place; nothing is added.
        var s = KeychainWrite.upsert(update: { calls.append("update"); return errSecSuccess }, add: { calls.append("add"); return errSecSuccess })
        check(s == errSecSuccess && calls == ["update"], "update in place")
        // A missing item is added.
        calls = []
        s = KeychainWrite.upsert(update: { calls.append("update"); return errSecItemNotFound }, add: { calls.append("add"); return errSecSuccess })
        check(s == errSecSuccess && calls == ["update", "add"], "add when missing")
        // Any other failure returns as is; nothing else is tried, so the
        // stored value stays.
        calls = []
        s = KeychainWrite.upsert(update: { calls.append("update"); return errSecInteractionNotAllowed }, add: { calls.append("add"); return errSecSuccess })
        check(s == errSecInteractionNotAllowed && calls == ["update"], "keep the stored value on failure")

        check(PreviewPolicy.opensLetter(.always), "previews always: text")
        check(PreviewPolicy.opensLetter(.whenAuthenticated), "previews when unlocked: text, which iOS hides while locked")
        check(!PreviewPolicy.opensLetter(.never), "previews never: placeholder")
        print("swift checks: 6 passed")
    }
}
