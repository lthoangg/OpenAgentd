// Called from the Rust shell (`mobile/src-tauri/src/widgets.rs`) with a
// validated snapshot. Stores it in the App Group and asks WidgetKit to
// redraw. Compiled into the app target by `scripts/patch-ios-widget.sh`.

import Foundation
import WidgetKit

@_cdecl("openagentd_widget_write")
public func openagentdWidgetWrite(_ json: UnsafePointer<CChar>) -> Bool {
    guard WidgetStorage.save(Data(String(cString: json).utf8)) else { return false }
    WidgetCenter.shared.reloadAllTimelines()
    return true
}
