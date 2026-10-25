// Hands a home-screen widget's deep link to the app's main activity.
//
// The main activity is singleTask. When its task survives but the process
// does not, Android recreates it with the task's original launcher intent and
// delivers the link through onNewIntent before any Tauri plugin has loaded,
// so the deep-link plugin never sees it. Without a live webview this starts
// the activity in a fresh task instead, where the link is the launch intent
// the plugin reads on load. With one, it goes through onNewIntent as usual
// and the open page keeps its state.

package app.openagentd.shell

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class WidgetLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val link = intent?.data
        if (link != null && link.scheme?.startsWith("openagentd") == true) {
            var flags = Intent.FLAG_ACTIVITY_NEW_TASK
            if (!ShellPlugin.webViewLoaded) flags = flags or Intent.FLAG_ACTIVITY_CLEAR_TASK
            val open = Intent(Intent.ACTION_VIEW, link).setPackage(packageName).addFlags(flags)
            try {
                startActivity(open)
            } catch (_: Exception) {
                // Nothing in this app handles the link; the tap does nothing.
            }
        }
        finish()
        overridePendingTransition(0, 0)
    }
}
