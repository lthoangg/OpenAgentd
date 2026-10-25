// Home-screen widget snapshot, shared by the app (which writes it) and the
// widget extension (which reads it). Same JSON shape as
// `mobile/src-tauri/src/widgets.rs`. Compiled into both targets by
// `mobile/scripts/patch-ios-widget.sh`.

import Foundation

struct WidgetSession: Codable, Hashable {
    enum State: String, Codable {
        case needsInput = "needs_input"
        case running
        case idle
    }

    let id: String
    let title: String
    let workspace: String?
    let state: State
    let lastMessageAt: Date?
}

struct WidgetTask: Codable, Hashable {
    let id: String
    let name: String
    let nextFireAt: Date
    let lastRunAt: Date?
    let lastRunOk: Bool?
}

struct WidgetSnapshot: Codable, Hashable {
    let updatedAt: Date
    let lastSession: WidgetSession?
    let inbox: [WidgetSession]
    let nextTask: WidgetTask?
}

enum WidgetStorage {
    private static let fileName = "widget-snapshot.json"

    /// The App Group the app and the extension share. A sideloading tool
    /// that re-signs the app (SideStore, AltStore) renames the group and
    /// lists the new name under `ALTAppGroups`; a build from source names it
    /// in `OAWidgetAppGroup`. Nil when neither is usable: the widgets then
    /// show only what needs no data.
    static var appGroup: String? {
        let info = Bundle.main.infoDictionary ?? [:]
        if let groups = info["ALTAppGroups"] as? [String],
           let group = groups.first(where: { !$0.isEmpty }) {
            return group
        }
        if let group = info["OAWidgetAppGroup"] as? String, !group.isEmpty, !group.contains("$(") {
            return group
        }
        return nil
    }

    static var snapshotURL: URL? {
        guard let group = appGroup,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { return nil }
        return container.appendingPathComponent(fileName)
    }

    /// Timestamps come from JavaScript (`toISOString`, with milliseconds) or
    /// the server (microseconds, or an offset): try each shape.
    private static func parseDate(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return date }
        // Microseconds: keep the first three fraction digits.
        if let dot = text.firstIndex(of: ".") {
            let digits = text[text.index(after: dot)...].prefix(while: { $0.isNumber })
            let trimmed = text.replacingCharacters(
                in: dot..<text.index(dot, offsetBy: 1 + digits.count),
                with: "." + digits.prefix(3)
            )
            if let date = withFraction.date(from: trimmed) { return date }
        }
        return nil
    }

    static func decode(_ data: Data) -> WidgetSnapshot? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = parseDate(text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Bad date \(text)")
            }
            return date
        }
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    static func load() -> WidgetSnapshot? {
        guard let url = snapshotURL, let data = try? Data(contentsOf: url) else { return nil }
        return decode(data)
    }

    /// Store the JSON the shell validated. False without a usable App Group.
    static func save(_ data: Data) -> Bool {
        guard let url = snapshotURL else { return false }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
