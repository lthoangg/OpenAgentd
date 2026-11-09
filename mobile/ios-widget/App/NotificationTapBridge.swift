// Which account notification the person tapped, for the Rust shell
// (`mobile/src-tauri/src/cloud.rs`, `cloud_take_notification`). Compiled
// into the app target by `scripts/patch-ios-widget.sh` (every Swift file in
// ios-widget/App is).
//
// The notification plugin owns the UNUserNotificationCenter delegate and
// ignores remote pushes. This wraps it: every call is forwarded unchanged,
// and a tap on a remote push whose payload says `"t": "approval"` (the
// cloud's "A device wants to join your account", which carries no secret
// and no device name) is remembered until the web UI asks, which then opens
// the pending approvals. Nothing is trusted from the push: the approval
// sheet reads the requests with signed calls and still needs the code.

import Foundation
import UserNotifications

private final class NotificationTaps: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationTaps()

    /// The delegate this one wraps. `UNUserNotificationCenter.delegate` is
    /// weak, so it is held here.
    private var inner: UNUserNotificationCenterDelegate?
    private let lock = NSLock()
    private var approvalTapped = false

    func install() {
        let center = UNUserNotificationCenter.current()
        if center.delegate === self { return }
        inner = center.delegate
        center.delegate = self
    }

    func takeApproval() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let tapped = approvalTapped
        approvalTapped = false
        return tapped
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let request = response.notification.request
        let remote = request.trigger?.isKind(of: UNPushNotificationTrigger.self) == true
        if remote, response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           (request.content.userInfo["t"] as? String) == "approval"
            || request.content.categoryIdentifier == "approval"
        {
            lock.lock()
            approvalTapped = true
            lock.unlock()
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
/// notification plugin set its delegate.
@_cdecl("openagentd_notification_taps_install")
public func openagentdNotificationTapsInstall() {
    // Synchronously during launch, so a tap that launched the app reaches it.
    if Thread.isMainThread {
        NotificationTaps.shared.install()
    } else {
        DispatchQueue.main.async { NotificationTaps.shared.install() }
    }
}

/// 1 when an approval notification was tapped since the last call, else 0.
@_cdecl("openagentd_notification_take_approval")
public func openagentdNotificationTakeApproval() -> Int32 {
    NotificationTaps.shared.takeApproval() ? 1 : 0
}
