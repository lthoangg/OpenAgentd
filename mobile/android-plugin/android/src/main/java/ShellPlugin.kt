// Android half of the OpenAgentd mobile shell bridge. Called only from the
// shell's Rust code (see ../../../../src/android.rs), never from JavaScript.

package app.openagentd.shell

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.math.roundToInt

@InvokeArg
class ShareArgs {
    lateinit var path: String
}

@InvokeArg
class SecretArgs {
    lateinit var service: String
    lateinit var user: String
    var value: String? = null
}

@InvokeArg
class CloudKeyArgs {
    /** 0 identity, 1 box, 2 sign (`CloudKeyStore`). */
    var item: Int = -1
    var value: String? = null
    /** The line the system prompt shows when item 2 is read. */
    var reason: String? = null
}

@InvokeArg
class PushContextArgs {
    /** JSON, or null to forget it (signed out). */
    var json: String? = null
}

@InvokeArg
class WidgetArgs {
    /** Snapshot JSON, validated by the shell's `widgets.rs`. */
    lateinit var snapshot: String
}

@InvokeArg
class ThemeArgs {
    /** "light", "dark", or "system", validated by the shell's `theme.rs`. */
    lateinit var preference: String
}

@TauriPlugin
class ShellPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        /**
         * Largest system font scale the web UI follows: the same cap as iOS
         * Dynamic Type (`web/src/lib/dynamic-type.ts`), past which a phone
         * has too little width left for the layout.
         */
        const val MAX_FONT_SCALE = 1.25f

        /**
         * The intent extra the notification plugin (tauri-plugin-notification,
         * `NOTIFICATION_INTENT_KEY`) puts the tapped notification's id in.
         */
        const val NOTIFICATION_ID_EXTRA = "NotificationId"

        /**
         * The WebView `textZoom` (percent) for a system font scale. Like iOS
         * it never shrinks the UI below its design size, and it ignores a
         * scale that is not a usable number.
         */
        fun textZoomPercent(fontScale: Float): Int =
            if (!fontScale.isFinite() || fontScale <= 0f) 100
            else (fontScale.coerceIn(1f, MAX_FONT_SCALE) * 100).roundToInt()

        /**
         * Whether the app's webview is up in this process. WidgetLinkActivity
         * reads it to pick how to hand a widget's deep link to the app.
         */
        @Volatile
        var webViewLoaded = false
            private set

        /** The app is on screen (the push service skips some banners then). */
        @Volatile
        var inForeground = false
            private set
    }

    private val secrets by lazy { KeystoreSecretStore(activity.applicationContext) }
    private val cloudKeys by lazy { CloudKeyStore(activity.applicationContext) }
    private val themePrefs by lazy {
        activity.applicationContext.getSharedPreferences("openagentd_theme", Activity.MODE_PRIVATE)
    }
    private var webView: WebView? = null

    /**
     * The id of the app's own notification whose tap started this activity.
     * The notification plugin reports that tap before the page listens, so
     * the shell reads it once with [takeLaunchNotification].
     */
    private var launchNotification: Int? = null

    /** Account push taps (`AccountNotifications`) the page has not read yet. */
    private val accountTaps = mutableListOf<String>()

    /** Queues the account tap `intent` carries, if this app posted it. */
    private fun queueAccountTap(intent: Intent?): Boolean {
        val tap = intent?.getStringExtra(AccountNotifications.TAP_EXTRA) ?: return false
        val key = intent.getStringExtra(AccountNotifications.TAP_KEY_EXTRA)
        intent.removeExtra(AccountNotifications.TAP_EXTRA)
        intent.removeExtra(AccountNotifications.TAP_KEY_EXTRA)
        // Another app can start this activity with any extras; only a
        // notification posted here knows the key.
        if (key == null || key != AccountNotifications.tapKey(activity.applicationContext)) return false
        synchronized(accountTaps) { accountTaps.add(tap) }
        return true
    }

    /** The boot page's paper tone (web/index.html) for an appearance. */
    private fun paper(dark: Boolean): Int =
        if (dark) 0xFF15110D.toInt() else 0xFFFAF6EC.toInt()

    private fun systemIsDark(): Boolean =
        (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    /** The web UI's last theme pick, or the system appearance without one. */
    private fun isDark(preference: String?): Boolean = when (preference) {
        "dark" -> true
        "light" -> false
        else -> systemIsDark()
    }

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        webViewLoaded = true
        launchNotification = activity.intent
            ?.takeIf { it.action == Intent.ACTION_MAIN }
            ?.getIntExtra(NOTIFICATION_ID_EXTRA, Int.MIN_VALUE)
            ?.takeIf { it != Int.MIN_VALUE }
        queueAccountTap(activity.intent)
        applyFontScale(activity.resources.configuration.fontScale)
        fitAboveKeyboard(webView)
        // Tauri applies the config's single (light) backgroundColor right
        // after this hook. Repaint once it has, in the theme the page will
        // paint, so a dark launch shows dark paper until the page does.
        val dark = isDark(themePrefs.getString("preference", null))
        webView.post { webView.setBackgroundColor(paper(dark)) }
    }

    /**
     * Keep the WebView above the soft keyboard. The activity draws edge to
     * edge (`enableEdgeToEdge`, target SDK 35+), so Android no longer resizes
     * the window for the keyboard (`adjustResize` stops applying), and a
     * WebView that does not inset itself for it (System WebView 124 does not)
     * left the keyboard over the composer: the page's visual viewport never
     * shrank, so the web never saw the keyboard (`data-keyboard-open`, the
     * composer's swipe down to put it away).
     *
     * The WebView's parent takes the keyboard's height as bottom padding, so
     * the page is laid out above it and its viewport shrinks as on iOS. The
     * WebView then gets the insets without the keyboard, so a WebView that
     * does handle it never counts it twice.
     */
    private fun fitAboveKeyboard(webView: WebView) {
        val parent = webView.parent as? android.view.View ?: return
        ViewCompat.setOnApplyWindowInsetsListener(parent) { view, insets ->
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            if (view.paddingBottom != keyboard) {
                view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, keyboard)
            }
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build()
        }
        ViewCompat.requestApplyInsets(parent)
    }

    /**
     * Android's WebView ignores the system font size unless the app sets
     * `textZoom` (it is 100 by default, and neither wry's `RustWebView` nor
     * Tauri touches it), so the page stayed at design size however large the
     * user's text was. Zoom it by the system scale, capped at
     * [MAX_FONT_SCALE].
     *
     * `textZoom` is the page's only system-size factor: iOS's Dynamic Type
     * hook (`useDynamicType`) is iOS-only, and the app's own Text size is CSS
     * (`--oa-text-scale`) applied before the zoom. So the result is system
     * scale x Text size, each counted once.
     *
     * The manifest does not list `fontScale` in `configChanges`, so changing
     * the system font size recreates the activity and [load] reads the new
     * value; [onConfigurationChanged] covers a manifest that starts handling
     * it.
     */
    private fun applyFontScale(fontScale: Float) {
        val view = webView ?: return
        val percent = textZoomPercent(fontScale)
        // WebSettings belong to the UI thread; posting also queues this ahead
        // of the page load Tauri posts after `load`, so the first paint is
        // already zoomed.
        view.post { view.settings.textZoom = percent }
    }

    /**
     * A tapped account notification while the app runs. The page reads taps
     * when it becomes visible; the app may already be in front, so it is
     * told as it would be on resume.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (!queueAccountTap(intent)) return
        webView?.post {
            webView?.evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'))", null)
        }
    }

    override fun onResume() {
        super.onResume()
        inForeground = true
    }

    override fun onPause() {
        inForeground = false
        super.onPause()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyFontScale(newConfig.fontScale)
    }

    override fun onDestroy() {
        webViewLoaded = false
        webView = null
        super.onDestroy()
    }

    /** Share a file from the app cache directory through the system chooser. */
    @Command
    fun shareFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareArgs::class.java)
            val file = File(args.path).canonicalFile
            val cacheDir = activity.cacheDir.canonicalFile
            // The FileProvider only maps the cache directory; refuse anything
            // else up front with a clear error instead of an opaque exception.
            if (!file.path.startsWith(cacheDir.path + File.separator) || !file.isFile) {
                invoke.reject("Only downloaded files in the app cache can be shared")
                return
            }
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.openagentd.fileprovider",
                file,
            )
            val mime = MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(file.extension.lowercase())
                ?: "application/octet-stream"
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                // ClipData carries the read grant through the chooser.
                clipData = ClipData.newRawUri(file.name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(Intent.createChooser(send, file.name))
                    invoke.resolve()
                } catch (ex: Exception) {
                    invoke.reject(ex.message ?: "Could not open the share sheet")
                }
            }
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Could not share the file")
        }
    }

    @Command
    fun secretGet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretArgs::class.java)
            val result = JSObject()
            secrets.get(args.service, args.user)?.let { result.put("value", it) }
            invoke.resolve(result)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Credential store unavailable")
        }
    }

    @Command
    fun secretSet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretArgs::class.java)
            val value = args.value
            if (value == null) {
                invoke.reject("Missing secret value")
                return
            }
            secrets.set(args.service, args.user, value)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Credential store unavailable")
        }
    }

    @Command
    fun secretDelete(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SecretArgs::class.java)
            val result = JSObject()
            result.put("deleted", secrets.delete(args.service, args.user))
            invoke.resolve(result)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Credential store unavailable")
        }
    }

    /** Whether this phone can hold account keys: `{ api, secureLock, hardware }`. */
    @Command
    fun cloudKeysAvailability(invoke: Invoke) {
        try {
            val a = cloudKeys.availability()
            val result = JSObject()
            result.put("api", a.api)
            result.put("secureLock", a.secureLock)
            result.put("hardware", a.hardware)
            invoke.resolve(result)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Keystore unavailable")
        }
    }

    @Command
    fun cloudKeySet(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CloudKeyArgs::class.java)
            val value = args.value ?: return invoke.reject("Missing key value")
            cloudKeys.set(args.item, value)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Keystore unavailable")
        }
    }

    /**
     * `{ status, value?, message? }`. Reading item 2 shows the system prompt
     * (fingerprint or screen lock) and answers once the person is done.
     */
    @Command
    fun cloudKeyGet(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(CloudKeyArgs::class.java)
        } catch (ex: Exception) {
            return invoke.reject(ex.message ?: "Invalid key item")
        }
        val answer = { read: CloudKeyStore.Read ->
            val result = JSObject()
            result.put("status", read.status)
            read.value?.let { result.put("value", it) }
            read.message?.let { result.put("message", it) }
            invoke.resolve(result)
        }
        try {
            if (args.item != CloudKeyStore.SIGN) return answer(cloudKeys.get(args.item))
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                return answer(CloudKeyStore.Read("error", message = "Accounts need Android 11 or later."))
            }
            cloudKeys.unlockSign(activity, args.reason ?: "", answer)
        } catch (ex: Exception) {
            answer(CloudKeyStore.Read("error", message = ex.message ?: ex.javaClass.simpleName))
        }
    }

    /** Signing out: every account key item and both Keystore keys. `{ left }` */
    @Command
    fun cloudKeysClear(invoke: Invoke) {
        try {
            cloudKeys.clear()
            val result = JSObject()
            result.put("left", cloudKeys.hasAnyKey())
            invoke.resolve(result)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Keystore unavailable")
        }
    }

    /** Save the home-screen widget snapshot and redraw the placed widgets. */
    @Command
    fun updateWidgets(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(WidgetArgs::class.java)
            val context = activity.applicationContext
            WidgetStore.save(context, args.snapshot)
            Widgets.refreshAll(context)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Could not update widgets")
        }
    }

    /**
     * Send the app to the background, as Back does on a root activity. The
     * web UI owns Back, so it calls this on its first screen instead of
     * finishing the activity.
     */
    @Command
    fun moveTaskToBack(invoke: Invoke) {
        activity.runOnUiThread {
            activity.moveTaskToBack(true)
            invoke.resolve()
        }
    }

    /**
     * The notification tap that started the app, once, and the account push
     * taps since the last call: `{ id?, taps? }` (`taps` a JSON array).
     */
    @Command
    fun takeLaunchNotification(invoke: Invoke) {
        val result = JSObject()
        launchNotification?.let { result.put("id", it) }
        launchNotification = null
        val taps = synchronized(accountTaps) { accountTaps.toList().also { accountTaps.clear() } }
        if (taps.isNotEmpty()) result.put("taps", taps.joinToString(",", "[", "]"))
        invoke.resolve(result)
    }

    /** What the push service needs to open letters (`Push.setContext`). */
    @Command
    fun setPushContext(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(PushContextArgs::class.java)
            Push.setContext(activity.applicationContext, args.json)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Could not keep the push context")
        }
    }

    /** `{ configured, enabled, token?, error? }`: waits for Firebase's token. */
    @Command
    fun pushState(invoke: Invoke) {
        val context = activity.applicationContext
        val result = JSObject()
        result.put("configured", Push.configured())
        result.put("enabled", Push.notificationsEnabled(context))
        if (!Push.configured()) return invoke.resolve(result)
        Push.token(context) { token, error ->
            token?.let { result.put("token", it) }
            error?.let { result.put("error", it) }
            invoke.resolve(result)
        }
    }

    /**
     * Match the status and navigation bar icons and the webview background
     * to the web UI's theme, not the system's, and remember the pick for the
     * next launch's background (see [load]).
     */
    @Command
    fun setAppTheme(invoke: Invoke) {
        val preference = try {
            invoke.parseArgs(ThemeArgs::class.java).preference
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Invalid theme")
            return
        }
        themePrefs.edit().putString("preference", preference).apply()
        activity.runOnUiThread {
            val dark = isDark(preference)
            WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            webView?.setBackgroundColor(paper(dark))
            invoke.resolve()
        }
    }

    /**
     * Open the system installer for an update APK the shell downloaded into
     * the cache directory (and checked against the feed's SHA-256). Android
     * itself refuses it unless it is signed with the installed app's key.
     * Until the user allows installs from OpenAgentd, this opens that
     * setting and rejects, so the UI can ask them to try again.
     */
    @Command
    fun installApk(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ShareArgs::class.java)
            val file = File(args.path).canonicalFile
            val cacheDir = activity.cacheDir.canonicalFile
            if (!file.path.startsWith(cacheDir.path + File.separator) || !file.isFile || file.extension != "apk") {
                invoke.reject("Only a downloaded update in the app cache can be installed")
                return
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !activity.packageManager.canRequestPackageInstalls()
            ) {
                val settings = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                )
                activity.runOnUiThread { activity.startActivity(settings) }
                invoke.reject("Allow OpenAgentd to install apps, then tap Install again")
                return
            }
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.openagentd.fileprovider",
                file,
            )
            val install = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(install)
                    invoke.resolve()
                } catch (ex: Exception) {
                    invoke.reject(ex.message ?: "Could not open the installer")
                }
            }
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Could not install the update")
        }
    }
}
