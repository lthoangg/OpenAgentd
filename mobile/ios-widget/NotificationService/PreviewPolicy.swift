// What the Notification Service Extension puts into a notification from a
// letter that opened, given the person's Show Previews setting.
//
// iOS applies the setting to whatever text a notification carries:
// `.whenAuthenticated` shows it only while the phone is unlocked, `.never`
// not at all (Apple's UNShowPreviewsSetting). So the text never shows more
// than the setting allows. With `.never` there is nothing to show, so the
// letter's text is left out and the generic placeholder stays; an unknown
// setting keeps the placeholder too.
//
// Where a tap goes (the session, and the computer it is on) is not preview
// text and is never shown: it is kept whatever the setting, so a tap on the
// placeholder still opens the session.

import UserNotifications

enum PreviewPolicy {
    static func showsText(_ setting: UNShowPreviewsSetting) -> Bool {
        switch setting {
        case .always, .whenAuthenticated: return true
        case .never: return false
        @unknown default: return false
        }
    }

    /// What a notification takes from a letter that opened.
    struct Fill: Equatable {
        /// The letter's title and body; nil keeps the placeholder.
        var text: (title: String, body: String)?
        /// The session a tap opens and the computer it is on; nil opens the app as it is.
        var route: (session: String, sender: String)?

        static func == (a: Fill, b: Fill) -> Bool {
            a.text?.title == b.text?.title && a.text?.body == b.text?.body
                && a.route?.session == b.route?.session && a.route?.sender == b.route?.sender
        }
    }

    static func fill(
        title: String, body: String, session: String?, sender: String, setting: UNShowPreviewsSetting
    ) -> Fill {
        let route = session.flatMap { $0.isEmpty ? nil : (session: $0, sender: sender) }
        return Fill(text: showsText(setting) ? (title: title, body: body) : nil, route: route)
    }
}
