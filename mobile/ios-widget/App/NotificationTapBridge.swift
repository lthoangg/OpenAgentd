// Which notification the person tapped, for the Rust shell
// (`mobile/src-tauri/src/taps.rs`, `notification_take_taps`). Compiled into
// the app target by `scripts/patch-ios-widget.sh` (every Swift file in
// ios-widget/App is).
//
// The notification plugin owns the UNUserNotificationCenter delegate. This
// wraps it and keeps every tap on a notification's body in one queue until
// the web UI takes it, so a tap that launched the app (before the page
// loaded) is not lost:
// * a remote push whose payload says `"t": "approval"` (the cloud's "A
//   device wants to join your account", which carries no secret);
// * a remote push the Notification Service Extension opened: the session it
//   is about and the computer that sealed it (`session`, `sender`);
// * a notification the app posted itself, by its id (the web UI remembers
//   which session and server each id is about).
// Taps on the app's own notifications are not forwarded to the plugin: it
// reads them from a map that is empty after a relaunch (and crashes on the
// missing entry), and the queue already routes them. Nothing is trusted from
// a push: the approval sheet reads requests with signed calls, and a
// session tap only opens a computer of the verified roster.

import Foundation
import UserNotifications

private final class NotificationTaps: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationTaps()

    /// The delegate this one wraps. `UNUserNotificationCenter.delegate` is
    /// weak, so it is held here.
    private var inner: UNUserNotificationCenterDelegate?
    private let lock = NSLock()
    private var taps: [[String: Any]] = []
    /// Told after each tap is queued (the shell emits an event to the page).
    var onTap: (@convention(c) () -> Void)?

    /// Taps kept until the web UI asks; older ones go first.
    private static let maxTaps = 8

    func install() {
        let center = UNUserNotificationCenter.current()
        if center.delegate === self { return }
        inner = center.delegate
        center.delegate = self
    }

    /// The queued taps as a JSON array, oldest first, and empties the queue.
    func take() -> String {
        lock.lock()
        let taken = taps
        taps = []
        lock.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: taken),
              let text = String(data: data, encoding: .utf8)
        else { return "[]" }
        return text
    }

    private func push(_ tap: [String: Any]) {
        lock.lock()
        taps.append(tap)
        if taps.count > Self.maxTaps { taps.removeFirst(taps.count - Self.maxTaps) }
        lock.unlock()
        onTap?()
    }

    /// What a tap on this notification's body opens, or nil.
    static func tap(for request: UNNotificationRequest) -> [String: Any]? {
        let content = request.content
        let remote = request.trigger?.isKind(of: UNPushNotificationTrigger.self) == true
        if remote {
            if (content.userInfo["t"] as? String) == "approval" || content.categoryIdentifier == "approval" {
                return ["kind": "approval"]
            }
            guard let session = content.userInfo["session"] as? String, !session.isEmpty else { return nil }
            var tap: [String: Any] = ["kind": "session", "session": session]
            if let sender = content.userInfo["sender"] as? String, !sender.isEmpty { tap["sender"] = sender }
            return tap
        }
        guard let id = Int(request.identifier) else { return nil }
        return ["kind": "local", "id": id]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let request = response.notification.request
        let remote = request.trigger?.isKind(of: UNPushNotificationTrigger.self) == true
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            if let tap = Self.tap(for: request) { push(tap) }
            if !remote {
                completionHandler()
                return
            }
        }
        if let inner, inner.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
            inner.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
        } else {
            completionHandler()
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if let inner, inner.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
            inner.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
        } else {
            completionHandler([])
        }
    }
}

/// Wraps the current notification delegate. Call once at launch, after the
/// notification plugin set its delegate. `onTap` is called (on any thread)
/// after each queued tap.
@_cdecl("openagentd_notification_taps_install")
public func openagentdNotificationTapsInstall(_ onTap: (@convention(c) () -> Void)?) {
    NotificationTaps.shared.onTap = onTap
    // Synchronously during launch, so a tap that launched the app reaches it.
    if Thread.isMainThread {
        NotificationTaps.shared.install()
    } else {
        DispatchQueue.main.async { NotificationTaps.shared.install() }
    }
}

/// The taps since the last call, as a JSON array in `out` (free it with
/// `openagentd_notification_free`). Returns 0.
@_cdecl("openagentd_notification_take_taps")
public func openagentdNotificationTakeTaps(_ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32 {
    out.pointee = strdup(NotificationTaps.shared.take())
    return 0
}

@_cdecl("openagentd_notification_free")
public func openagentdNotificationFree(_ p: UnsafeMutablePointer<CChar>?) {
    free(p)
}
