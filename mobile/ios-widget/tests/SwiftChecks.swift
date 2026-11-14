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

        check(PreviewPolicy.showsText(.always), "previews always: text")
        check(PreviewPolicy.showsText(.whenAuthenticated), "previews when unlocked: text, which iOS hides while locked")
        check(!PreviewPolicy.showsText(.never), "previews never: placeholder")

        // Where a tap goes is not preview text: it is kept whatever the setting.
        let shown = PreviewPolicy.fill(title: "Done · web", body: "Fix the build", session: "s1", sender: "dev-mac", setting: .always)
        check(shown.text?.title == "Done · web" && shown.text?.body == "Fix the build", "previews always: the letter's text")
        check(shown.route?.session == "s1" && shown.route?.sender == "dev-mac", "previews always: the tap opens the session")
        let hidden = PreviewPolicy.fill(title: "Done · web", body: "Fix the build", session: "s1", sender: "dev-mac", setting: .never)
        check(hidden.text == nil, "previews never: no text")
        check(hidden.route?.session == "s1" && hidden.route?.sender == "dev-mac", "previews never: the tap still opens the session")
        let noSession = PreviewPolicy.fill(title: "Done", body: "", session: "", sender: "dev-mac", setting: .always)
        check(noSession.route == nil, "a letter without a session opens the app as it is")
        print("swift checks: 11 passed")
    }
}
