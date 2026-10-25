// Home-screen widgets: Quick start (small), Sessions inbox (medium) and Next
// task (small). They draw the snapshot WidgetStore holds and open the app
// through its `openagentd://` deep links; they never talk to the server.

package app.openagentd.shell

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews

/** After this long, "Needs you" / "Working" may be over: show a plain age instead. */
private const val STATUS_FRESH_MS = 30 * 60_000L
private const val SCHEME = "openagentd"

internal object Widgets {
    private val providers = listOf(
        QuickStartWidget::class.java,
        InboxWidget::class.java,
        NextTaskWidget::class.java,
    )

    /** Redraw every placed OpenAgentd widget from the stored snapshot. */
    fun refreshAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        for (provider in providers) {
            val ids = manager.getAppWidgetIds(ComponentName(context, provider))
            if (ids.isEmpty()) continue
            val update = Intent(context, provider)
                .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
            context.sendBroadcast(update)
        }
    }

    fun link(context: Context, url: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, WidgetLinkActivity::class.java)
            .setData(Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun sessionUrl(id: String) = "$SCHEME://session/${Uri.encode(id)}"
    fun newSessionUrl() = "$SCHEME://new"
    fun appUrl() = "$SCHEME://session"
    fun schedulerUrl(taskId: String?) =
        if (taskId == null) "$SCHEME://scheduler" else "$SCHEME://scheduler?task=${Uri.encode(taskId)}"

    /** "now", "5m", "2h", "3d". */
    fun age(now: Long, at: Long?): String {
        if (at == null) return ""
        val minutes = ((now - at) / 60_000L).coerceAtLeast(0)
        return when {
            minutes < 1 -> "now"
            minutes < 60 -> "${minutes}m"
            minutes < 24 * 60 -> "${minutes / 60}h"
            else -> "${minutes / (24 * 60)}d"
        }
    }

    fun asOf(context: Context, now: Long, updatedAt: Long): String {
        val age = age(now, updatedAt)
        return if (age == "now") context.getString(R.string.openagentd_widget_as_of_now)
        else context.getString(R.string.openagentd_widget_as_of, age)
    }

    /** A request code unique to one widget instance and one tap target. */
    fun requestCode(widgetId: Int, slot: Int) = widgetId * 16 + slot
}

class QuickStartWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val snapshot = WidgetStore.load(context)
        val now = System.currentTimeMillis()
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.openagentd_widget_quick)
            val last = snapshot?.lastSession
            if (last != null) {
                views.setTextViewText(R.id.openagentd_widget_quick_title, last.title)
                val meta = listOfNotNull(last.workspace, Widgets.age(now, last.lastMessageAt).ifEmpty { null })
                views.setTextViewText(R.id.openagentd_widget_quick_meta, meta.joinToString(" · "))
                views.setViewVisibility(R.id.openagentd_widget_quick_label, View.VISIBLE)
                views.setOnClickPendingIntent(
                    R.id.openagentd_widget_quick_last,
                    Widgets.link(context, Widgets.sessionUrl(last.id), Widgets.requestCode(id, 0)),
                )
            } else {
                views.setTextViewText(R.id.openagentd_widget_quick_title, context.getString(R.string.openagentd_widget_no_sessions))
                views.setTextViewText(R.id.openagentd_widget_quick_meta, "")
                views.setViewVisibility(R.id.openagentd_widget_quick_label, View.GONE)
                views.setOnClickPendingIntent(
                    R.id.openagentd_widget_quick_last,
                    Widgets.link(context, Widgets.appUrl(), Widgets.requestCode(id, 0)),
                )
            }
            views.setOnClickPendingIntent(
                R.id.openagentd_widget_quick_new,
                Widgets.link(context, Widgets.newSessionUrl(), Widgets.requestCode(id, 1)),
            )
            manager.updateAppWidget(id, views)
        }
    }
}

class InboxWidget : AppWidgetProvider() {
    private val rows = listOf(
        Row(R.id.openagentd_widget_inbox_row0, null, R.id.openagentd_widget_inbox_title0, R.id.openagentd_widget_inbox_meta0, R.id.openagentd_widget_inbox_pill0),
        Row(R.id.openagentd_widget_inbox_row1, R.id.openagentd_widget_inbox_divider1, R.id.openagentd_widget_inbox_title1, R.id.openagentd_widget_inbox_meta1, R.id.openagentd_widget_inbox_pill1),
        Row(R.id.openagentd_widget_inbox_row2, R.id.openagentd_widget_inbox_divider2, R.id.openagentd_widget_inbox_title2, R.id.openagentd_widget_inbox_meta2, R.id.openagentd_widget_inbox_pill2),
    )

    private data class Row(val row: Int, val divider: Int?, val title: Int, val meta: Int, val pill: Int)

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val snapshot = WidgetStore.load(context)
        val now = System.currentTimeMillis()
        val fresh = snapshot != null && now - snapshot.updatedAt < STATUS_FRESH_MS
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.openagentd_widget_inbox)
            views.setTextViewText(
                R.id.openagentd_widget_inbox_as_of,
                if (snapshot == null) "" else Widgets.asOf(context, now, snapshot.updatedAt),
            )
            views.setOnClickPendingIntent(
                R.id.openagentd_widget_inbox_header,
                Widgets.link(context, Widgets.appUrl(), Widgets.requestCode(id, 0)),
            )
            val sessions = snapshot?.inbox.orEmpty()
            views.setViewVisibility(R.id.openagentd_widget_inbox_empty, if (sessions.isEmpty()) View.VISIBLE else View.GONE)
            rows.forEachIndexed { index, row ->
                val session = sessions.getOrNull(index)
                row.divider?.let { views.setViewVisibility(it, if (session == null) View.GONE else View.VISIBLE) }
                if (session == null) {
                    views.setViewVisibility(row.row, View.GONE)
                    return@forEachIndexed
                }
                views.setViewVisibility(row.row, View.VISIBLE)
                views.setTextViewText(row.title, session.title)
                views.setTextViewText(row.meta, session.workspace ?: "")
                val (label, background) = when {
                    fresh && session.state == "needs_input" ->
                        context.getString(R.string.openagentd_widget_needs_you) to R.drawable.openagentd_widget_pill_needs
                    fresh && session.state == "running" ->
                        context.getString(R.string.openagentd_widget_working) to R.drawable.openagentd_widget_pill_running
                    else -> Widgets.age(now, session.lastMessageAt) to R.drawable.openagentd_widget_pill_idle
                }
                views.setTextViewText(row.pill, label)
                views.setInt(row.pill, "setBackgroundResource", background)
                views.setOnClickPendingIntent(
                    row.row,
                    Widgets.link(context, Widgets.sessionUrl(session.id), Widgets.requestCode(id, index + 1)),
                )
            }
            manager.updateAppWidget(id, views)
        }
    }
}

class NextTaskWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val task = WidgetStore.load(context)?.nextTask
        val now = System.currentTimeMillis()
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.openagentd_widget_task)
            if (task == null) {
                views.setTextViewText(R.id.openagentd_widget_task_name, context.getString(R.string.openagentd_widget_no_tasks))
                views.setTextViewText(R.id.openagentd_widget_task_when, "")
                views.setTextViewText(R.id.openagentd_widget_task_in, "")
                views.setViewVisibility(R.id.openagentd_widget_task_last_row, View.GONE)
            } else {
                views.setTextViewText(R.id.openagentd_widget_task_name, task.name)
                // An absolute time stays right however old the snapshot is.
                val sameDay = DateUtils.isToday(task.nextFireAt)
                val flags = DateUtils.FORMAT_SHOW_TIME or
                    (if (sameDay) 0 else DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_WEEKDAY)
                views.setTextViewText(R.id.openagentd_widget_task_when, DateUtils.formatDateTime(context, task.nextFireAt, flags))
                views.setTextViewText(
                    R.id.openagentd_widget_task_in,
                    if (task.nextFireAt > now) {
                        DateUtils.getRelativeTimeSpanString(task.nextFireAt, now, DateUtils.MINUTE_IN_MILLIS)
                    } else {
                        ""
                    },
                )
                views.setViewVisibility(R.id.openagentd_widget_task_last_row, if (task.lastRunOk == null) View.GONE else View.VISIBLE)
                if (task.lastRunOk != null) {
                    views.setTextViewText(
                        R.id.openagentd_widget_task_last,
                        context.getString(if (task.lastRunOk) R.string.openagentd_widget_run_ok else R.string.openagentd_widget_run_failed),
                    )
                    views.setInt(
                        R.id.openagentd_widget_task_last,
                        "setBackgroundResource",
                        if (task.lastRunOk) R.drawable.openagentd_widget_pill_idle else R.drawable.openagentd_widget_pill_failed,
                    )
                }
            }
            views.setOnClickPendingIntent(
                R.id.openagentd_widget_task_root,
                Widgets.link(context, Widgets.schedulerUrl(task?.id), Widgets.requestCode(id, 0)),
            )
            manager.updateAppWidget(id, views)
        }
    }
}
