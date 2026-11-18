package app.openagentd.shell

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Firebase Cloud Messaging for the account's pushes (Remote control).
 *
 * The Firebase settings come from a `google-services.json` kept outside the
 * repository, read at build time (`OPENAGENTD_GOOGLE_SERVICES_JSON`, see
 * `build.gradle.kts`) into [BuildConfig]. A build without them has no push:
 * [configured] is false and nothing talks to Firebase.
 *
 * Firebase is started here by hand rather than by the Google Services Gradle
 * plugin, which would need the file inside the generated app project.
 */
internal object Push {
    private const val PREFS = "openagentd.push"
    private const val CONTEXT = "context"

    fun configured(): Boolean =
        BuildConfig.FIREBASE_APP_ID.isNotEmpty() &&
            BuildConfig.FIREBASE_API_KEY.isNotEmpty() &&
            BuildConfig.FIREBASE_PROJECT_ID.isNotEmpty() &&
            BuildConfig.FIREBASE_SENDER_ID.isNotEmpty()

    /** The default Firebase app, started on first use; null without settings. */
    @Synchronized
    fun firebase(context: Context): FirebaseApp? {
        if (!configured()) return null
        FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }?.let { return it }
        val options = FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
            .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
            .build()
        return FirebaseApp.initializeApp(context.applicationContext, options)
    }

    fun notificationsEnabled(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** The FCM registration token, or why there is none. Calls [done] once. */
    fun token(context: Context, done: (String?, String?) -> Unit) {
        if (firebase(context) == null) return done(null, "Push notifications are not set up in this build.")
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful && !task.result.isNullOrEmpty()) done(task.result, null)
                else done(null, task.exception?.message ?: "Firebase gave no token.")
            }
        } catch (ex: Exception) {
            done(null, ex.message ?: "Firebase is unavailable.")
        }
    }

    /**
     * What the push service needs to open letters (`push_context` in the
     * shell's cloud.rs): the account id, this phone's device id and its
     * computers' box keys. Not secret; null forgets it (signed out).
     */
    fun setContext(context: Context, json: String?) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (json == null) prefs.remove(CONTEXT) else prefs.putString(CONTEXT, json)
        prefs.commit()
    }

    fun context(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CONTEXT, null)
}
