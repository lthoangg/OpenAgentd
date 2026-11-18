package app.openagentd.shell

import android.content.Context
import org.json.JSONObject

/**
 * Opens an account push's sealed letter with the shell's own Rust code
 * (`mobile/src-tauri/src/push_android.rs` → `push::open_letter`), so the
 * letter format has one implementation. A push may start the process
 * without the activity; the library is then loaded here.
 */
internal object Letters {
    /** The shell's Rust library (Tauri's `WRY_ANDROID_LIBRARY`). */
    private const val LIBRARY = "openagentd_mobile_lib"

    private val loaded: Boolean by lazy {
        try {
            System.loadLibrary(LIBRARY)
            true
        } catch (_: Throwable) {
            false
        }
    }

    class Opened(
        val title: String,
        val body: String,
        val session: String?,
        val sender: String,
        val kind: String,
    )

    @JvmStatic
    private external fun openNative(sealed: String, boxSeed: String, context: String): String?

    @JvmStatic
    private external fun openDeviceNative(): String?

    /** The letter's text and route, or null when it does not open. */
    fun open(context: Context, sealed: String): Opened? {
        if (!loaded) return null
        val read = CloudKeyStore(context).get(CloudKeyStore.BOX)
        val seed = read.value?.takeIf { read.status == "ok" } ?: return null
        val pushContext = Push.context(context) ?: return null
        val json = try {
            openNative(sealed, seed, pushContext)
        } catch (_: Throwable) {
            null
        } ?: return null
        return try {
            val o = JSONObject(json)
            Opened(
                title = o.getString("title"),
                body = o.getString("body"),
                session = if (o.has("session")) o.getString("session") else null,
                sender = o.getString("sender"),
                kind = o.getString("kind"),
            )
        } catch (_: Exception) {
            null
        }
    }

    /** The account computer the app is on now, if it runs and is on one. */
    fun openDevice(): String? = if (!loaded) null else try {
        openDeviceNative()
    } catch (_: Throwable) {
        null
    }
}
