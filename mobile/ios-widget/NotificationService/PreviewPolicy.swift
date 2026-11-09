// Whether the Notification Service Extension puts a letter's text into a
// notification, given the person's Show Previews setting.
//
// iOS applies the setting to whatever text a notification carries:
// `.whenAuthenticated` shows it only while the phone is unlocked, `.never`
// not at all (Apple's UNShowPreviewsSetting). So the text never shows more
// than the setting allows. With `.never` there is nothing to show, so the
// letter is not even opened and the generic placeholder stays; an unknown
// setting keeps the placeholder too.

import UserNotifications

enum PreviewPolicy {
    static func opensLetter(_ setting: UNShowPreviewsSetting) -> Bool {
        switch setting {
        case .always, .whenAuthenticated: return true
        case .never: return false
        @unknown default: return false
        }
    }
}
