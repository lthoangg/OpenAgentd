// Whether a Cloud push is shown as a banner while the app is open
// (NotificationTapBridge.swift, `willPresent`). Plain Foundation, so
// tests/run-swift-checks.sh compiles it on macOS.
//
// Every account push is shown, even from the computer the app is on: the
// computer holds a push for a minute and drops it when the session was seen
// (appv3/crates/api/src/cloud/letters.rs), and the app reports seen each
// banner it shows itself (web/src/lib/desktop-notifications.ts). A push
// that still arrives was shown nowhere, e.g. one raised just before the app
// came back on screen, which the app leaves to the push.

import Foundation

enum ForegroundPush {
    static func showsBanner(remote: Bool, notice: String?) -> Bool {
        guard remote else { return false }
        // The approval notice keeps its own handling.
        return notice == nil
    }
}
