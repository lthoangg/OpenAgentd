//! macOS: taking a delivered notification out of Notification Center.
//!
//! mac-notification-sys posts through `NSUserNotificationCenter` and keeps
//! the identifier it gives each notification to itself, so one is found
//! again by what it says.

/// Remove one delivered notification with this title and body; false when
/// there is none. Two sessions with the same words are told apart by
/// nothing here: either one's goes, and each still has one left.
pub fn remove_delivered(title: &str, body: &str) -> bool {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let (title, body) = (NSString::from_str(title), NSString::from_str(body));
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: `NSUserNotificationCenter` and `NSUserNotification` are
        // documented as thread safe. Every object is used inside this pool
        // and checked for nil before it is messaged; the selectors and their
        // types are Foundation's (`deliveredNotifications` is an `NSArray`
        // of `NSUserNotification`, whose `title` and `informativeText` are
        // `NSString` or nil).
        unsafe {
            let center: *mut AnyObject = msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
            if center.is_null() {
                return false;
            }
            let delivered: *mut AnyObject = msg_send![center, deliveredNotifications];
            if delivered.is_null() {
                return false;
            }
            let says = |text: *mut AnyObject, wanted: &NSString| -> bool {
                if text.is_null() {
                    return wanted.is_empty();
                }
                msg_send![text, isEqualToString: wanted]
            };
            let count: usize = msg_send![delivered, count];
            for index in 0..count {
                let notification: *mut AnyObject = msg_send![delivered, objectAtIndex: index];
                if notification.is_null() {
                    continue;
                }
                let its_title: *mut AnyObject = msg_send![notification, title];
                let its_body: *mut AnyObject = msg_send![notification, informativeText];
                if says(its_title, &title) && says(its_body, &body) {
                    let _: () = msg_send![center, removeDeliveredNotification: notification];
                    return true;
                }
            }
            false
        }
    })
}
