package app.openagentd.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.security.SecureRandom

/**
 * The account's pushes (agentd-cloud sends FCM data-only messages): a sealed
 * letter `l` with its id `i` for Done, Needs you and Failed, or
 * `t: "approval"` when a device asks to join. The Android counterpart of the
 * iOS Notification Service Extension: the letter is opened on the phone and
 * the notification is posted from here.
 *
 * A letter that does not open shows the placeholder ("OpenAgentd", "New
 * activity"), and a tap then just opens the app. Notifications are private:
 * the lock screen shows the placeholder unless the person allows sensitive
 * content there.
 */
class OpenAgentdMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        Push.firebase(this)
        super.onCreate()
    }

    /** The app registers the current token at every launch (`cloud_push_register`). */
    override fun onNewToken(token: String) {}

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["t"] == "approval") {
            AccountNotifications.approval(this)
            return
        }
        val sealed = data["l"] ?: return
        val opened = Letters.open(this, sealed)
        // The app shows the notifications of the computer it is on itself
        // (it hears that computer's events); any other computer's push is
        // shown even while the app is open (`ForegroundPush.swift`).
        if (opened != null && ShellPlugin.inForeground && opened.sender == Letters.openDevice()) return
        AccountNotifications.letter(this, opened, data["i"])
    }
}

/** Posting the account's notifications, and what their taps carry. */
internal object AccountNotifications {
    /** The intent extra with the tap (`taps.rs`: approval or session). */
    const val TAP_EXTRA = "openagentd.tap"
    /** Proves a tap came from a notification this app posted. */
    const val TAP_KEY_EXTRA = "openagentd.tap.key"

    private const val PREFS = "openagentd.push"
    private const val KEY = "tap_key"
    private const val APPROVAL_ID = 0x0A11

    private class Channel(val id: String, val name: String, val importance: Int)

    private val done = Channel("account_done", "Done", NotificationManager.IMPORTANCE_DEFAULT)
    private val needsYou = Channel("account_needs_you", "Needs you", NotificationManager.IMPORTANCE_HIGH)
    private val failed = Channel("account_failed", "Failed", NotificationManager.IMPORTANCE_HIGH)
    private val approvals = Channel("account_approvals", "Devices asking to join", NotificationManager.IMPORTANCE_HIGH)
    private val other = Channel("account_activity", "Other activity", NotificationManager.IMPORTANCE_DEFAULT)

    fun approval(context: Context) {
        val tap = JSONObject().put("kind", "approval")
        post(context, approvals, APPROVAL_ID, "OpenAgentd", "A device wants to join your account", tap)
    }

    fun letter(context: Context, opened: Letters.Opened?, letterId: String?) {
        if (opened == null) {
            post(context, other, (letterId ?: "activity").hashCode(), "OpenAgentd", "New activity", null)
            return
        }
        val channel = when (opened.kind) {
            "done" -> done
            "needs_you" -> needsYou
            "failed" -> failed
            else -> other
        }
        val tap = opened.session?.let {
            JSONObject().put("kind", "session").put("session", it).put("sender", opened.sender)
        }
        // One notification per session: a newer letter replaces the older.
        post(context, channel, (opened.session ?: letterId ?: opened.title).hashCode(), opened.title, opened.body, tap)
    }

    /** The key a tap must carry; made once per install, never leaves the app. */
    @Synchronized
    fun tapKey(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val key = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString(KEY, key).commit()
        return key
    }

    private fun post(context: Context, channel: Channel, id: Int, title: String, body: String, tap: JSONObject?) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(channel.id, channel.name, channel.importance))
        }
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (tap != null) {
                putExtra(TAP_EXTRA, tap.toString())
                putExtra(TAP_KEY_EXTRA, tapKey(context))
            }
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        val content = launch?.let { PendingIntent.getActivity(context, id, it, flags) }
        // A one-colour glyph (the tray template): Android draws only its alpha.
        val icon = R.drawable.openagentd_notification
        fun builder(): Notification.Builder =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, channel.id)
            else @Suppress("DEPRECATION") Notification.Builder(context)
        val placeholder = builder()
            .setSmallIcon(icon)
            .setContentTitle("OpenAgentd")
            .setContentText("New activity")
            .build()
        val notification = builder()
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(placeholder)
            .apply { if (content != null) setContentIntent(content) }
            .build()
        try {
            manager.notify(id, notification)
        } catch (_: SecurityException) {
            // Notifications are off for the app (Android 13+ permission).
        }
    }
}
