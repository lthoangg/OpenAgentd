// Home-screen widget snapshot: what the app last knew, saved by the web UI
// through `ShellPlugin.updateWidgets` and read by the AppWidget providers in
// Widgets.kt. Same JSON shape as `mobile/src-tauri/src/widgets.rs`.

package app.openagentd.shell

import android.content.Context
import org.json.JSONObject
import java.util.Calendar
import java.util.TimeZone

internal data class WidgetSession(
    val id: String,
    val title: String,
    val workspace: String?,
    /** "needs_input", "running" or "idle". */
    val state: String,
    val lastMessageAt: Long?,
)

internal data class WidgetTask(
    val id: String,
    val name: String,
    val nextFireAt: Long,
    val lastRunOk: Boolean?,
)

internal data class WidgetSnapshot(
    val updatedAt: Long,
    val lastSession: WidgetSession?,
    val inbox: List<WidgetSession>,
    val nextTask: WidgetTask?,
)

internal object WidgetStore {
    private const val PREFS = "openagentd_widgets"
    private const val KEY = "snapshot"

    fun save(context: Context, json: String) {
        // commit, not apply: the providers read it right after this returns.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).commit()
    }

    fun load(context: Context): WidgetSnapshot? {
        val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
        return try {
            parse(JSONObject(json))
        } catch (_: Exception) {
            null
        }
    }

    private fun parse(root: JSONObject): WidgetSnapshot {
        val inbox = root.optJSONArray("inbox")
        return WidgetSnapshot(
            updatedAt = parseIsoMillis(root.optString("updatedAt")) ?: 0L,
            lastSession = root.optJSONObject("lastSession")?.let(::parseSession),
            inbox = (0 until (inbox?.length() ?: 0)).mapNotNull { inbox?.optJSONObject(it)?.let(::parseSession) },
            nextTask = root.optJSONObject("nextTask")?.let(::parseTask),
        )
    }

    private fun parseSession(item: JSONObject) = WidgetSession(
        id = item.getString("id"),
        title = item.optString("title"),
        workspace = item.optStringOrNull("workspace"),
        state = item.optString("state", "idle"),
        lastMessageAt = parseIsoMillis(item.optStringOrNull("lastMessageAt")),
    )

    private fun parseTask(item: JSONObject): WidgetTask? {
        val fireAt = parseIsoMillis(item.optStringOrNull("nextFireAt")) ?: return null
        return WidgetTask(
            id = item.getString("id"),
            name = item.optString("name"),
            nextFireAt = fireAt,
            lastRunOk = if (item.isNull("lastRunOk") || !item.has("lastRunOk")) null else item.getBoolean("lastRunOk"),
        )
    }

    private fun JSONObject.optStringOrNull(name: String): String? =
        if (isNull(name) || !has(name)) null else optString(name)

    private val ISO = Regex(
        """^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$""",
    )

    /**
     * Epoch millis of an ISO 8601 timestamp; null when it does not parse.
     * Hand-rolled because java.time needs API 26 and the app supports 24.
     * A timestamp without an offset is UTC, as the server writes them.
     */
    fun parseIsoMillis(value: String?): Long? {
        val match = ISO.matchEntire(value?.trim() ?: return null) ?: return null
        val g = match.groupValues
        val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            clear()
            set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt())
        }
        val millis = g[7].padEnd(3, '0').take(3).toInt()
        val zone = g[8]
        val offsetMinutes = if (zone.isEmpty() || zone == "Z") {
            0
        } else {
            val digits = zone.substring(1).replace(":", "")
            val minutes = digits.substring(0, 2).toInt() * 60 + digits.substring(2, 4).toInt()
            if (zone[0] == '-') -minutes else minutes
        }
        return calendar.timeInMillis + millis - offsetMinutes * 60_000L
    }
}
