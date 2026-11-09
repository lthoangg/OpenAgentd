// APNs registration for the Rust shell (`mobile/src-tauri/src/push.rs`):
// the notification authorization status, the permission prompt, and the
// device token. Compiled into the app target by `scripts/patch-ios-widget.sh`
// (every Swift file in ios-widget/App is).
//
// Every entry point answers exactly once through a C callback with the
// caller's context pointer, on any thread. Nothing here talks to a server.
//
// The app delegate is Tauri's (tao's `TaoAppDelegate`, declared in Rust), so
// there is no Swift delegate to add the token callbacks to. They are added to
// whatever class the delegate is at runtime, the first time a registration is
// asked for: `class_addMethod` when the class does not implement the selector
// (tao implements neither, so nothing of tao's is replaced), and otherwise a
// replacement that calls the original first. This touches two selectors and
// leaves the delegate object and its class identity alone, which is less
// invasive than a delegate proxy (it would have to forward every other
// UIApplicationDelegate call, and own tao's delegate).

import Foundation
import ObjectiveC
import UIKit
import UserNotifications

public typealias OpenAgentdPushStatusCallback =
    @convention(c) (Int32, UnsafeMutableRawPointer?) -> Void
public typealias OpenAgentdPushTokenCallback =
    @convention(c) (UnsafePointer<CChar>?, UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void

/// The codes `push.rs` reads: 0 not determined, 1 denied, 2 authorized.
/// Provisional and ephemeral authorization deliver notifications, so they
/// count as authorized; an unknown future status counts as denied.
private func statusCode(_ status: UNAuthorizationStatus) -> Int32 {
    switch status {
    case .notDetermined: return 0
    case .denied: return 1
    case .authorized, .provisional, .ephemeral: return 2
    @unknown default: return 1
    }
}

/// Current authorization, without prompting.
@_cdecl("openagentd_push_authorization_status")
public func openagentdPushAuthorizationStatus(
    _ callback: OpenAgentdPushStatusCallback, _ context: UnsafeMutableRawPointer?
) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
        callback(statusCode(settings.authorizationStatus), context)
    }
}

/// Show the system prompt (iOS shows it only while the status is not
/// determined), then answer with the resulting status.
@_cdecl("openagentd_push_request_authorization")
public func openagentdPushRequestAuthorization(
    _ callback: OpenAgentdPushStatusCallback, _ context: UnsafeMutableRawPointer?
) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
        center.getNotificationSettings { settings in
            callback(statusCode(settings.authorizationStatus), context)
        }
    }
}

/// Register with APNs and answer with the device token as lowercase hex,
/// or with the error iOS reported. Never prompts.
@_cdecl("openagentd_push_register")
public func openagentdPushRegister(
    _ callback: OpenAgentdPushTokenCallback, _ context: UnsafeMutableRawPointer?
) {
    let pending = PendingRegistration(callback: callback, context: context)
    DispatchQueue.main.async { PushRegistrar.shared.register(pending) }
}

private struct PendingRegistration {
    let callback: OpenAgentdPushTokenCallback
    let context: UnsafeMutableRawPointer?

    func finish(token: String?, error: String?) {
        let call = { (token: UnsafePointer<CChar>?, error: UnsafePointer<CChar>?) in
            callback(token, error, context)
        }
        switch (token, error) {
        case let (token?, _): token.withCString { call($0, nil) }
        case let (nil, error?): error.withCString { call(nil, $0) }
        case (nil, nil): call(nil, nil)
        }
    }
}

/// Main-thread only: the pending callers and the delegate hook.
private final class PushRegistrar {
    static let shared = PushRegistrar()

    private var pending: [PendingRegistration] = []
    private var hooked = false
    /// Held while the delegate is reassigned (see `hookDelegate`), and after:
    /// `UIApplication.delegate` does not retain it.
    private var delegate: UIApplicationDelegate?

    func register(_ registration: PendingRegistration) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard hookDelegate() else {
            registration.finish(token: nil, error: "No app delegate to receive the APNs token")
            return
        }
        pending.append(registration)
        // One request answers every caller waiting on it.
        if pending.count == 1 {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    private func finishAll(token: String?, error: String?) {
        dispatchPrecondition(condition: .onQueue(.main))
        let waiting = pending
        pending = []
        waiting.forEach { $0.finish(token: token, error: error) }
    }

    private func hookDelegate() -> Bool {
        if hooked { return true }
        guard let delegate = UIApplication.shared.delegate else { return false }
        let cls: AnyClass = type(of: delegate)

        addHook(
            cls,
            #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))
        ) { [weak self] value in
            let hex = (value as? Data).map { $0.map { String(format: "%02x", $0) }.joined() }
            self?.finishAll(token: hex, error: hex == nil ? "APNs returned no device token" : nil)
        }
        addHook(
            cls,
            #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))
        ) { [weak self] value in
            let message = (value as? Error)?.localizedDescription ?? "APNs registration failed"
            self?.finishAll(token: nil, error: message)
        }

        // UIApplication caches which optional delegate methods exist when the
        // delegate is set; setting it again makes it see the added ones.
        self.delegate = delegate
        UIApplication.shared.delegate = nil
        UIApplication.shared.delegate = delegate
        hooked = true
        return true
    }

    /// Give `cls` an implementation of `selector` (an
    /// `application(_:…:)` delegate method taking one object) that calls the
    /// class's own implementation, if any, and then `handler`.
    private func addHook(_ cls: AnyClass, _ selector: Selector, _ handler: @escaping (Any?) -> Void) {
        typealias Original = @convention(c) (AnyObject, Selector, UIApplication, AnyObject?) -> Void
        let original = class_getInstanceMethod(cls, selector).map(method_getImplementation)
        let block: @convention(block) (AnyObject, UIApplication, AnyObject?) -> Void = { this, app, value in
            if let original {
                unsafeBitCast(original, to: Original.self)(this, selector, app, value)
            }
            handler(value)
        }
        let imp = imp_implementationWithBlock(block)
        // "v@:@@": returns void; self, _cmd, the application, one object.
        if !class_addMethod(cls, selector, imp, "v@:@@"), let method = class_getInstanceMethod(cls, selector) {
            method_setImplementation(method, imp)
        }
    }
}
