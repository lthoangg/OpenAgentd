// The Notification Service Extension: replaces a push's placeholder text
// ("OpenAgentd", "New activity") with the text of the end-to-end encrypted
// letter it carries. Added to the Xcode project by
// `scripts/patch-ios-widget.sh`.
//
// It reads, from storage shared with the app (the App Group):
// * the box seed, a Keychain item in the App Group's access group, readable
//   after first unlock (`ios-widget/App/KeychainBridge.swift`);
// * `cloud-push.json`: the account id, this phone's device id, and the box
//   keys of the computers in its verified roster. Not secret.
// A letter that does not open keeps the placeholder; nothing is logged.

import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        handler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        self.content = content
        if let opened = Self.open(request.content.userInfo), let text = LetterOpener.text(opened.json) {
            content.title = String(text.title.prefix(120))
            content.body = String(text.body.prefix(600))
            if let session = text.session, !session.isEmpty {
                content.threadIdentifier = session
                content.userInfo["session"] = session
            }
            content.userInfo["kind"] = opened.kind
            content.userInfo.removeValue(forKey: "l")
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = handler, let content = content { handler(content) }
    }

    private struct Context: Decodable {
        let account_id: String
        let me: String
        let senders: [String: String]
    }

    static func appGroup() -> String? {
        if let g = Bundle.main.infoDictionary?["OAWidgetAppGroup"] as? String, !g.isEmpty, !g.contains("$(") { return g }
        return nil
    }

    private static func open(_ info: [AnyHashable: Any]) -> LetterOpener.Opened? {
        guard let l = info["l"] as? String, let sealed = LetterOpener.fromB64(l),
              let group = appGroup(),
              let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let data = try? Data(contentsOf: dir.appendingPathComponent("cloud-push.json")),
              let ctx = try? JSONDecoder().decode(Context.self, from: data),
              let seed = boxSeed(group: group)
        else { return nil }
        var senders: [String: Data] = [:]
        for (id, box) in ctx.senders { if let b = LetterOpener.fromB64(box) { senders[id] = b } }
        return LetterOpener.open(
            sealed: sealed, recipientBoxSeed: seed, recipientID: ctx.me, accountID: ctx.account_id, senders: senders
        )
    }

    private static func boxSeed(group: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.openagentd.cloud",
            kSecAttrAccount as String: "box",
            kSecAttrAccessGroup as String: group,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let text = String(data: data, encoding: .utf8)
        else { return nil }
        return LetterOpener.fromB64(text)
    }
}
