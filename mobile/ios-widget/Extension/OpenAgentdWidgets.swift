// Home-screen widgets: Quick start, Sessions inbox and Next task. They draw
// the snapshot the app saved (WidgetStorage) and open the app through its
// own deep links; they never talk to the server.

import SwiftUI
import WidgetKit

/// After this long, "Needs you" / "Working" may be over: show a plain age instead.
private let statusFreshFor: TimeInterval = 30 * 60

// MARK: - Deep links

private enum AppLink {
    /// The app's URL scheme (`openagentd`, or `openagentd-dev` for dev
    /// builds), read from the containing app's Info.plist.
    static let scheme: String = {
        let appURL = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        let types = Bundle(url: appURL)?.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        let schemes = types?.compactMap { $0["CFBundleURLSchemes"] as? [String] }.flatMap { $0 }
        return schemes?.first(where: { $0.hasPrefix("openagentd") }) ?? "openagentd"
    }()

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?&="))) ?? value
    }

    static var app: URL { URL(string: "\(scheme)://session")! }
    static var newSession: URL { URL(string: "\(scheme)://new")! }
    static func session(_ id: String) -> URL { URL(string: "\(scheme)://session/\(encode(id))") ?? app }
    static func scheduler(task: String?) -> URL {
        guard let task else { return URL(string: "\(scheme)://scheduler")! }
        return URL(string: "\(scheme)://scheduler?task=\(encode(task))") ?? app
    }
}

// MARK: - Palette (matches the app's paper tones, light and dark)

private extension Color {
    init(light: UInt32, dark: UInt32) {
        func color(_ hex: UInt32) -> UIColor {
            UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        }
        self.init(UIColor { $0.userInterfaceStyle == .dark ? color(dark) : color(light) })
    }

    static let widgetBackground = Color(light: 0xFFFBF1, dark: 0x1F1914)
    static let widgetBorder = Color(light: 0xE7DCBF, dark: 0x3A2F25)
    static let widgetText = Color(light: 0x1A1714, dark: 0xF3EDE0)
    static let widgetMuted = Color(light: 0x7A6A54, dark: 0xA8987F)
    static let buttonBackground = Color(light: 0x2D241B, dark: 0xFAF6EC)
    static let buttonText = Color(light: 0xFFFDF7, dark: 0x1A1714)
    static let needsBackground = Color(light: 0xFFF1D8, dark: 0x4A3112)
    static let needsText = Color(light: 0x873E05, dark: 0xF5C27A)
    static let runningBackground = Color(light: 0xDCEEFB, dark: 0x17324A)
    static let runningText = Color(light: 0x174A73, dark: 0x9CCBF0)
    static let idleBackground = Color(light: 0xF0E9D4, dark: 0x2E261D)
    static let idleText = Color(light: 0x6E604F, dark: 0xC9BBA0)
    static let failedBackground = Color(light: 0xFBE3EC, dark: 0x4A1A2C)
    static let failedText = Color(light: 0xA21D52, dark: 0xF2A0BE)
}

private extension View {
    /// iOS 17 wants the background declared as the widget's container.
    @ViewBuilder
    func widgetBackground() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { Color.widgetBackground }
        } else {
            padding().background(Color.widgetBackground)
        }
    }
}

private struct Pill: View {
    let text: String
    let foreground: Color
    let background: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .foregroundColor(foreground)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(background))
    }
}

private struct Header: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.widgetMuted)
    }
}

// MARK: - Timeline

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?

    /// Whether session states are recent enough to show as states.
    var statusFresh: Bool {
        guard let snapshot else { return false }
        return date.timeIntervalSince(snapshot.updatedAt) < statusFreshFor
    }
}

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: Date(), snapshot: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        let stored = WidgetStorage.load()
        completion(SnapshotEntry(date: Date(), snapshot: context.isPreview ? (stored ?? .sample) : stored))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date()
        let snapshot = WidgetStorage.load()
        var entries = [SnapshotEntry(date: now, snapshot: snapshot)]
        // Redraw when the states go stale, so the pills turn into ages.
        if let snapshot {
            let fade = snapshot.updatedAt.addingTimeInterval(statusFreshFor)
            if fade > now { entries.append(SnapshotEntry(date: fade, snapshot: snapshot)) }
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(statusFreshFor))))
    }
}

extension WidgetSnapshot {
    static let sample = WidgetSnapshot(
        updatedAt: Date(),
        lastSession: WidgetSession(id: "sample", title: "Fix flaky compaction test", workspace: "openagentd", state: .running, lastMessageAt: Date()),
        inbox: [
            WidgetSession(id: "a", title: "Deploy plan for v3.31", workspace: "openagentd", state: .needsInput, lastMessageAt: Date()),
            WidgetSession(id: "b", title: "Fix flaky compaction test", workspace: "openagentd", state: .running, lastMessageAt: Date()),
            WidgetSession(id: "c", title: "Release notes", workspace: "docs", state: .idle, lastMessageAt: Date().addingTimeInterval(-7200)),
        ],
        nextTask: WidgetTask(id: "t", name: "Daily repo digest", nextFireAt: Date().addingTimeInterval(8040), lastRunAt: nil, lastRunOk: true)
    )
}

// MARK: - Quick start

private struct NewSessionButton: View {
    var body: some View {
        Text("+ New session")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.buttonText)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(Capsule().fill(Color.buttonBackground))
    }
}

private struct LastSessionView: View {
    let session: WidgetSession?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let session {
                Text("Continue").font(.system(size: 11)).foregroundColor(.widgetMuted)
                Text(session.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.widgetText)
                    .lineLimit(2)
                HStack(spacing: 4) {
                    if let workspace = session.workspace { Text(workspace) }
                    if let at = session.lastMessageAt { Text("· \(at, style: .relative) ago") }
                }
                .font(.system(size: 11))
                .foregroundColor(.widgetMuted)
                .lineLimit(1)
            } else {
                Text("No sessions yet")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.widgetText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct QuickStartView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SnapshotEntry

    var body: some View {
        let last = entry.snapshot?.lastSession
        Group {
            if family == .systemSmall {
                // A small widget has a single tap target: it starts a session.
                VStack(alignment: .leading) {
                    Header(title: "OpenAgentd")
                    Spacer(minLength: 4)
                    if let workspace = last?.workspace {
                        Text("Start a session in").font(.system(size: 11)).foregroundColor(.widgetMuted)
                        Text(workspace)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.widgetText)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    NewSessionButton()
                }
                .widgetURL(AppLink.newSession)
            } else {
                VStack(alignment: .leading) {
                    Header(title: "OpenAgentd")
                    Spacer(minLength: 4)
                    Link(destination: last.map { AppLink.session($0.id) } ?? AppLink.app) {
                        LastSessionView(session: last)
                    }
                    Spacer(minLength: 4)
                    Link(destination: AppLink.newSession) { NewSessionButton() }
                }
            }
        }
        .widgetBackground()
    }
}

struct QuickStartWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OpenAgentdQuickStart", provider: SnapshotProvider()) { entry in
            QuickStartView(entry: entry)
        }
        .configurationDisplayName("Quick start")
        .description("Start a new session or continue your last one.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Sessions inbox

private struct InboxRow: View {
    let session: WidgetSession
    let statusFresh: Bool

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.widgetText)
                    .lineLimit(1)
                if let workspace = session.workspace {
                    Text(workspace).font(.system(size: 11)).foregroundColor(.widgetMuted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            pill
        }
    }

    @ViewBuilder private var pill: some View {
        switch (statusFresh, session.state) {
        case (true, .needsInput):
            Pill(text: "Needs you", foreground: .needsText, background: .needsBackground)
        case (true, .running):
            Pill(text: "Working", foreground: .runningText, background: .runningBackground)
        default:
            if let at = session.lastMessageAt {
                Text(at, style: .relative)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.idleText)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 64, alignment: .trailing)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.idleBackground))
            }
        }
    }
}

struct InboxView: View {
    let entry: SnapshotEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Link(destination: AppLink.app) {
                HStack {
                    Header(title: "Sessions")
                    Spacer()
                    if let updatedAt = entry.snapshot?.updatedAt {
                        Text("as of \(updatedAt, style: .relative) ago")
                            .font(.system(size: 11))
                            .foregroundColor(.widgetMuted)
                            .lineLimit(1)
                    }
                }
            }
            if let snapshot = entry.snapshot, !snapshot.inbox.isEmpty {
                ForEach(Array(snapshot.inbox.enumerated()), id: \.element.id) { index, session in
                    if index > 0 { Divider().overlay(Color.widgetBorder) }
                    Link(destination: AppLink.session(session.id)) {
                        InboxRow(session: session, statusFresh: entry.statusFresh)
                    }
                }
                Spacer(minLength: 0)
            } else {
                Spacer()
                Text(entry.snapshot == nil ? "Open OpenAgentd to load your sessions" : "Nothing needs you right now")
                    .font(.system(size: 12))
                    .foregroundColor(.widgetMuted)
                    .frame(maxWidth: .infinity)
                Spacer()
            }
        }
        .widgetBackground()
    }
}

struct InboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OpenAgentdInbox", provider: SnapshotProvider()) { entry in
            InboxView(entry: entry)
        }
        .configurationDisplayName("Sessions")
        .description("Sessions that need you or are still working.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Next task

struct NextTaskView: View {
    let entry: SnapshotEntry

    var body: some View {
        let task = entry.snapshot?.nextTask
        VStack(alignment: .leading, spacing: 2) {
            Header(title: "Next task")
            Spacer(minLength: 4)
            if let task {
                Text(task.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.widgetText)
                    .lineLimit(2)
                if task.nextFireAt > entry.date {
                    // The OS counts this down without a refresh.
                    Text(task.nextFireAt, style: .relative)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(.widgetText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                Text(task.nextFireAt, style: .time)
                    .font(.system(size: 11))
                    .foregroundColor(.widgetMuted)
                Spacer(minLength: 4)
                if let ok = task.lastRunOk {
                    HStack(spacing: 6) {
                        Text("Last run").font(.system(size: 11)).foregroundColor(.widgetMuted)
                        if ok {
                            Pill(text: "ok", foreground: .idleText, background: .idleBackground)
                        } else {
                            Pill(text: "failed", foreground: .failedText, background: .failedBackground)
                        }
                    }
                }
            } else {
                Text(entry.snapshot == nil ? "Open OpenAgentd to load your tasks" : "No scheduled tasks")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.widgetText)
                Spacer(minLength: 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(AppLink.scheduler(task: task?.id))
        .widgetBackground()
    }
}

struct NextTaskWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OpenAgentdNextTask", provider: SnapshotProvider()) { entry in
            NextTaskView(entry: entry)
        }
        .configurationDisplayName("Next task")
        .description("Your next scheduled task and how its last run went.")
        .supportedFamilies([.systemSmall])
    }
}

@main
struct OpenAgentdWidgets: WidgetBundle {
    var body: some Widget {
        QuickStartWidget()
        InboxWidget()
        NextTaskWidget()
    }
}
