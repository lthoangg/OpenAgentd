// Whether a Cloud push is shown as a banner while the app is open
// (NotificationTapBridge.swift, `willPresent`). Plain Foundation, so
// tests/run-swift-checks.sh compiles it on macOS.
//
// The app shows its own notifications only for the computer it is on (it
// hears that one's event stream). A push from any other computer of the
// account reaches the person nowhere else, so it is shown. The computer
// only sends it when nobody saw the session on a screen for a minute
// (appv3/crates/api/src/cloud/letters.rs).

import Foundation

enum ForegroundPush {
    /// `sender`: the computer the Notification Service Extension found in the
    /// letter, absent when it could not open it (or previews are off and it
    /// kept no route). `openDevice`: the computer the app is on, if any.
    static func showsBanner(remote: Bool, notice: String?, sender: String?, openDevice: String?) -> Bool {
        guard remote else { return false }
        // The approval notice keeps its own handling.
        if notice != nil { return false }
        guard let sender, !sender.isEmpty else { return true }
        return sender != openDevice
    }
}
