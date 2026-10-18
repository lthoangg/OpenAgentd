// Android half of the OpenAgentd mobile shell bridge. Called only from the
// shell's Rust code (see ../../../../src/android.rs), never from JavaScript.

package app.openagentd.shell

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

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

@TauriPlugin
class ShellPlugin(private val activity: Activity) : Plugin(activity) {
    private val secrets by lazy { KeystoreSecretStore(activity.applicationContext) }

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
}
