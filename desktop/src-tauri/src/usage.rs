//! Connected OAuth provider usage — fetch + tray formatting.
//!
//! Mirrors ``app/api/schemas/settings.py``'s ``ProviderUsageSummaryBody`` /
//! ``ProviderUsageSummaryItem`` / ``ProviderUsageResponse`` shapes served by
//! ``GET /api/settings/providers/usage-summary``. That single endpoint
//! fans in usage for every *connected* provider that exposes one — both
//! builtin OAuth providers (Codex, Copilot) and provider plugins that
//! define ``get_usage`` — so this module never needs to know the
//! provider catalog itself.
//!
//! Kept free of Tauri types so the formatting logic (the part worth unit
//! testing) can run without a live app handle — see the `tests` module.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UsageWindow {
    pub used_percent: f64,
    #[serde(default)]
    pub window_minutes: Option<i64>,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UsageCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    #[serde(default)]
    pub balance: Option<String>,
}

/// A spend cap, independent of any rate-limit window. ``reached`` is the
/// authoritative "am I blocked" signal — a provider can keep reporting
/// available credits while the cap is already exhausted.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UsageSpend {
    pub reached: bool,
    /// Mirrors the backend schema; the tray has no room for it.
    #[allow(dead_code)]
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub limit: Option<f64>,
    #[serde(default)]
    pub used: Option<f64>,
    #[serde(default)]
    pub remaining: Option<f64>,
    /// Can exceed 100 once the cap is breached — clamp the bar, not the text.
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UsageLimit {
    #[serde(default)]
    pub limit_id: Option<String>,
    #[serde(default)]
    pub limit_name: Option<String>,
    #[serde(default)]
    pub primary: Option<UsageWindow>,
    #[serde(default)]
    pub secondary: Option<UsageWindow>,
    #[serde(default)]
    pub credits: Option<UsageCredits>,
    #[serde(default)]
    pub spend: Option<UsageSpend>,
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub rate_limit_reached_type: Option<String>,
    #[serde(default)]
    pub period_start_at: Option<i64>,
    #[serde(default)]
    pub period_end_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UsageResponse {
    #[allow(dead_code)]
    pub provider: String,
    #[serde(default)]
    pub limits: Vec<UsageLimit>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct UsageSummaryItem {
    pub provider: String,
    pub label: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub usage: Option<UsageResponse>,
    /// True when the backend substituted this provider's last-known-good
    /// payload because the live fetch failed transiently.
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct UsageSummaryBody {
    #[serde(default)]
    pub items: Vec<UsageSummaryItem>,
    #[serde(default)]
    pub checked_at: i64,
    #[serde(default)]
    pub cached: bool,
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Process-wide HTTP client shared by every usage poll. Building a
/// ``reqwest::Client`` per request throws away its connection pool (and
/// pays a TLS handshake for external backends) every 5 minutes for the
/// lifetime of the app — a single lazily-built client keeps connections
/// warm. Also reused by ``commands.rs::wait_for_health`` via
/// [`shared_client`].
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Lazily-built shared client. Falls back to ``reqwest::Client::new()``
/// semantics on builder failure (which cannot realistically fail with
/// this configuration, but avoid panicking in release builds regardless).
pub fn shared_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

/// Fetch the aggregate usage summary from the local (or configured
/// external) OpenAgentd backend. ``token`` is the desktop session token
/// used for the bundled sidecar; external servers behind an access key
/// would also pass it as a bearer token.
pub async fn fetch_usage_summary(
    base_url: &str,
    token: Option<&str>,
    force_refresh: bool,
) -> Result<UsageSummaryBody> {
    let url = format!(
        "{}/api/settings/providers/usage-summary?force_refresh={}",
        base_url.trim_end_matches('/'),
        force_refresh
    );
    let mut request = shared_client().get(&url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .context("request provider usage summary")?
        .error_for_status()
        .context("provider usage summary returned an error status")?;
    response
        .json::<UsageSummaryBody>()
        .await
        .context("parse provider usage summary response")
}

/// One formatted tray row. ``id_suffix`` becomes part of the row's menu
/// item id (``usage_row:<id_suffix>``) — informational rows are disabled
/// so the id is never actually dispatched, but it must stay stable and
/// unique so repeated rebuilds don't confuse the underlying platform menu.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageRow {
    pub id_suffix: String,
    pub text: String,
}

fn status_glyph(percent: f64) -> &'static str {
    if percent >= 90.0 {
        "\u{1F534}" // 🔴
    } else if percent >= 70.0 {
        "\u{1F7E0}" // 🟠
    } else {
        "\u{1F7E2}" // 🟢
    }
}

/// Render a countdown like "2h 14m" / "38m" / "resetting now" from a unix
/// timestamp. We deliberately avoid wall-clock/timezone formatting here —
/// the tray has no reliable way to know the user's preferred locale, and
/// a relative countdown reads fine in any timezone.
fn format_reset_in(resets_at: i64, now_unix: i64) -> String {
    let remaining = resets_at - now_unix;
    if remaining <= 0 {
        return "resetting".to_string();
    }
    let minutes = remaining / 60;
    if minutes < 1 {
        return "resets <1m".to_string();
    }
    if minutes < 60 {
        return format!("resets {minutes}m");
    }
    let hours = minutes / 60;
    let rem_minutes = minutes % 60;
    if hours < 24 {
        return if rem_minutes == 0 {
            format!("resets {hours}h")
        } else {
            format!("resets {hours}h {rem_minutes}m")
        };
    }
    let days = hours / 24;
    let rem_hours = hours % 24;
    if rem_hours == 0 {
        format!("resets {days}d")
    } else {
        format!("resets {days}d {rem_hours}h")
    }
}

fn format_period_end_in(period_end_at: i64, now_unix: i64) -> String {
    let remaining = period_end_at - now_unix;
    if remaining <= 0 {
        return "ending now".to_string();
    }
    let minutes = remaining / 60;
    if minutes < 1 {
        return "ends <1m".to_string();
    }
    if minutes < 60 {
        return format!("ends {minutes}m");
    }
    let hours = minutes / 60;
    let rem_minutes = minutes % 60;
    if hours < 24 {
        return if rem_minutes == 0 {
            format!("ends {hours}h")
        } else {
            format!("ends {hours}h {rem_minutes}m")
        };
    }
    let days = hours / 24;
    let rem_hours = hours % 24;
    if rem_hours == 0 {
        format!("ends {days}d")
    } else {
        format!("ends {days}d {rem_hours}h")
    }
}

/// Hard cap on a single tray row's rendered width. Long plugin-supplied
/// limit names (or, in principle, a translated/localised label) could
/// otherwise stretch the native menu uncomfortably wide — mirrors the
/// same guardrail `menu.rs::TRAY_SESSION_MAX_LEN` applies to the session
/// line.
const MAX_ROW_LEN: usize = 96;

fn truncate_row(text: String) -> String {
    if text.chars().count() <= MAX_ROW_LEN {
        return text;
    }
    let mut truncated: String = text.chars().take(MAX_ROW_LEN.saturating_sub(1)).collect();
    truncated.push('\u{2026}');
    truncated
}



/// Number of segments in the inline text progress bar rendered next to
/// every percent figure — the closest a native (plain-text) tray menu
/// can get to CodexBar's popover meter bars.
const BAR_WIDTH: usize = 10;

/// Render a fixed-width block-character meter like ``\u{2588}\u{2588}\u{2588}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}``
/// for `percent`. Filled segments use a solid block, empty ones a light
/// shade block, so the row reads as a tiny bar even in a plain-text
/// native menu — mirroring CodexBar's popover meters (see its
/// screenshot in the project README) without needing custom menu
/// rendering, which Tauri's native `MenuItem` doesn't support.
fn render_bar(percent: f64) -> String {
    let filled = ((percent.clamp(0.0, 100.0) / 100.0) * BAR_WIDTH as f64).round() as usize;
    let filled = filled.min(BAR_WIDTH);
    let empty = BAR_WIDTH - filled;
    format!("{}{}", "\u{2588}".repeat(filled), "\u{2591}".repeat(empty))
}

/// The measurable tail of a limit row: ``42% \u{2588}\u{2588}\u{2588}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} · resets in 2h 14m · LIMIT
/// REACHED: …``. Shared by the single-row and grouped renderings.
/// ``None`` when the limit has no percent window at all (credits-only).
fn format_limit_suffix(limit: &UsageLimit, now_unix: i64) -> Option<(&'static str, String)> {
    let window = limit.primary.as_ref().or(limit.secondary.as_ref())?;
    let percent = window.used_percent.round() as i64;
    let glyph = status_glyph(window.used_percent);
    let bar = render_bar(window.used_percent);
    let reset_suffix = window
        .resets_at
        .map(|resets_at| format!(" \u{00B7} {}", format_reset_in(resets_at, now_unix)))
        .unwrap_or_default();
    // Compact: the fact that the limit is reached is the signal; the
    // provider-specific reason string is Settings → Providers material.
    let reached_suffix = limit
        .rate_limit_reached_type
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(|_| " \u{00B7} LIMIT REACHED")
        .unwrap_or_default();
    Some((glyph, format!("{percent}% {bar}{reset_suffix}{reached_suffix}")))
}

/// Row name given to a spend cap, appended to the limit's own name when
/// it has one so ``Codex · Spend cap`` stays self-explanatory.
const SPEND_LABEL: &str = "Spend cap";

/// A spend cap only earns its own row once it carries amounts. A bare
/// ``reached`` flag has nothing to measure — it steers the credits line
/// (see [`format_credits_line`]) instead of rendering an empty meter.
fn spend_figures(limit: &UsageLimit) -> Option<&UsageSpend> {
    limit
        .spend
        .as_ref()
        .filter(|spend| spend.limit.is_some() || spend.used.is_some())
}

/// Percent of the cap consumed. Prefers the upstream figure and falls
/// back to used/limit; can exceed 100 on a breached cap.
fn spend_percent(spend: &UsageSpend) -> f64 {
    if let Some(percent) = spend.used_percent {
        return percent;
    }
    match (spend.used, spend.limit) {
        (Some(used), Some(limit)) if limit > 0.0 => used / limit * 100.0,
        _ => 0.0,
    }
}

/// Group an amount the way the web panel's en-US `Intl.NumberFormat`
/// does (at most 2 fraction digits, no trailing zeros): `1811.965…` →
/// `1,811.97`, `700` → `700`.
fn format_amount(value: f64) -> String {
    let rounded = ((value * 100.0).round() / 100.0).abs();
    let whole = rounded.trunc() as i64;
    let cents = ((rounded - whole as f64) * 100.0).round() as i64;
    let digits = whole.to_string();
    let mut out = String::with_capacity(digits.len() + 4);
    if value.is_sign_negative() && (whole != 0 || cents != 0) {
        out.push('-');
    }
    for (idx, ch) in digits.char_indices() {
        if idx > 0 && (digits.len() - idx) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if cents != 0 {
        out.push('.');
        out.push_str(format!("{cents:02}").trim_end_matches('0'));
    }
    out
}

/// The measurable tail of a spend-cap row: ``259% ██████████ · resets 24d
/// · 1,811.97 of 700 used``. The bar clamps at 100 but the percent does
/// not — hiding the overage is what makes a breached cap unreadable.
fn format_spend_suffix(spend: &UsageSpend, now_unix: i64) -> (&'static str, String) {
    let percent = spend_percent(spend);
    let glyph = if spend.reached {
        "\u{1F534}" // 🔴 — blocked, whatever the percent says.
    } else {
        status_glyph(percent)
    };
    let reset_suffix = spend
        .resets_at
        .map(|resets_at| format!(" \u{00B7} {}", format_reset_in(resets_at, now_unix)))
        .unwrap_or_default();
    // Amounts answer "how much is left"; `remaining` is left to Settings
    // → Providers so the row still fits a native menu.
    let amounts = match (spend.used, spend.limit) {
        (Some(used), Some(limit)) => format!(
            " \u{00B7} {} of {} used",
            format_amount(used),
            format_amount(limit)
        ),
        (Some(used), None) => format!(" \u{00B7} {} used", format_amount(used)),
        (None, Some(limit)) => format!(" \u{00B7} {} cap", format_amount(limit)),
        (None, None) => String::new(),
    };
    (
        glyph,
        format!(
            "{}% {}{reset_suffix}{amounts}",
            percent.round() as i64,
            render_bar(percent)
        ),
    )
}

/// One renderable measurement inside a provider: a rate-limit window or a
/// spend cap. A limit can yield both — a cap is orthogonal to a rolling
/// window, so neither hides the other.
struct LimitEntry {
    glyph: &'static str,
    /// Row name in the grouped rendering; `None` falls back to the
    /// provider label.
    name: Option<String>,
    suffix: String,
    /// Percent used for the provider header's worst-case glyph.
    percent: f64,
}

fn limit_entries(limit: &UsageLimit, now_unix: i64) -> Vec<LimitEntry> {
    let mut entries = Vec::new();
    if let Some((glyph, suffix)) = format_limit_suffix(limit, now_unix) {
        let percent = limit
            .primary
            .as_ref()
            .or(limit.secondary.as_ref())
            .map(|window| window.used_percent)
            .unwrap_or_default();
        entries.push(LimitEntry {
            glyph,
            name: limit.limit_name.clone(),
            suffix,
            percent,
        });
    }
    if let Some(spend) = spend_figures(limit) {
        let (glyph, suffix) = format_spend_suffix(spend, now_unix);
        let name = match limit.limit_name.as_deref() {
            Some(limit_name) if !limit_name.is_empty() => {
                format!("{limit_name} \u{00B7} {SPEND_LABEL}")
            }
            _ => SPEND_LABEL.to_string(),
        };
        let percent = spend_percent(spend);
        entries.push(LimitEntry {
            glyph,
            name: Some(name),
            suffix,
            // A reached cap must colour the provider header red even when
            // upstream reports a modest percent.
            percent: if spend.reached {
                percent.max(CRITICAL_USAGE_PERCENT)
            } else {
                percent
            },
        });
    }
    entries
}

/// Render a provider with exactly one measurement as a single row that
/// always leads with the provider label — ``🟢 GitHub Copilot · Premium
/// requests · 0%`` — so the provider is identifiable even when the
/// measurement has its own name.
fn format_flat_line(label: &str, entry: &LimitEntry) -> String {
    let name_part = entry
        .name
        .as_deref()
        .filter(|name| !name.is_empty() && *name != label)
        .map(|name| format!(" \u{00B7} {name}"))
        .unwrap_or_default();
    format!(
        "{} {label}{name_part} \u{00B7} {}",
        entry.glyph, entry.suffix
    )
}

/// Indentation for grouped limit rows under a provider header.
const GROUP_INDENT: &str = "      ";

fn format_credits_line(label: &str, credits: &UsageCredits, spend: Option<&UsageSpend>) -> String {
    // A reached cap outranks has_credits, which stays true while blocked.
    let text = if spend.is_some_and(|spend| spend.reached) {
        format!("\u{1F534} {label} \u{00B7} usage limit reached")
    } else if credits.unlimited {
        format!("\u{1F7E2} {label} \u{00B7} unlimited usage")
    } else if credits.has_credits {
        let balance = credits
            .balance
            .as_deref()
            .map(|b| format!(" ({b})"))
            .unwrap_or_default();
        format!("\u{1F7E2} {label} \u{00B7} credits available{balance}")
    } else {
        format!("\u{1F534} {label} \u{00B7} no usage credits left")
    };
    truncate_row(text)
}

fn format_period_line(label: &str, limit: &UsageLimit, now_unix: i64) -> String {
    let name = limit.limit_name.as_deref().unwrap_or(label);
    let end = limit
        .period_end_at
        .map(|period_end_at| {
            format!(
                " \u{00B7} {}",
                format_period_end_in(period_end_at, now_unix)
            )
        })
        .unwrap_or_default();
    truncate_row(format!(
        "\u{26AA} {label} \u{00B7} {name} \u{00B7} period available{end}"
    ))
}

/// Build the tray's dynamic usage rows for one provider's summary item.
/// A single connected provider can report multiple limit windows (e.g.
/// Codex's primary quota plus per-feature add-ons); each becomes its own
/// row so nothing is silently hidden, capped at `max_limits_per_provider`
/// to keep the menu scannable.
fn format_item_rows(item: &UsageSummaryItem, now_unix: i64, max_limits: usize) -> Vec<UsageRow> {
    match item.status.as_str() {
        "credentials_missing" => vec![UsageRow {
            id_suffix: format!("{}:missing", item.provider),
            text: truncate_row(format!("\u{26AA} {} \u{00B7} reconnect", item.label)),
        }],
        "unavailable" => vec![UsageRow {
            id_suffix: format!("{}:unavailable", item.provider),
            text: truncate_row(format!(
                "\u{26A0}\u{FE0F} {} \u{00B7} unavailable",
                item.label
            )),
        }],
        _ => {
            let Some(usage) = item.usage.as_ref() else {
                return vec![UsageRow {
                    id_suffix: format!("{}:empty", item.provider),
                    text: truncate_row(format!("\u{26AA} {} \u{00B7} no usage data", item.label)),
                }];
            };
            // Backend substituted last-known-good data for a transient
            // failure — keep the numbers visible but mark them, compactly.
            let stale_suffix = if item.stale { " (old)" } else { "" };
            let measurable: Vec<LimitEntry> = usage
                .limits
                .iter()
                .flat_map(|limit| limit_entries(limit, now_unix))
                .collect();

            if measurable.is_empty() {
                let first = usage.limits.first();
                let text = if let Some(credits) = first.and_then(|l| l.credits.as_ref()) {
                    format_credits_line(&item.label, credits, first.and_then(|l| l.spend.as_ref()))
                } else if let Some(period_limit) = usage
                    .limits
                    .iter()
                    .find(|limit| limit.period_start_at.is_some() || limit.period_end_at.is_some())
                {
                    format_period_line(&item.label, period_limit, now_unix)
                } else {
                    truncate_row(format!("\u{26AA} {} \u{00B7} no usage data", item.label))
                };
                return vec![UsageRow {
                    id_suffix: format!("{}:0", item.provider),
                    text: truncate_row(format!("{text}{stale_suffix}")),
                }];
            }

            // Single measurement: one flat row leading with the provider label.
            if measurable.len() == 1 {
                let line = format_flat_line(&item.label, &measurable[0]);
                return vec![UsageRow {
                    id_suffix: format!("{}:0", item.provider),
                    text: truncate_row(format!("{line}{stale_suffix}")),
                }];
            }

            // Multiple measurements (per-model providers, multi-window
            // providers, or a window plus a spend cap): one provider
            // header carrying the *worst* glyph, then indented rows so
            // names aren't each prefixed with the (repetitive) provider
            // label.
            let worst = measurable
                .iter()
                .map(|entry| entry.percent)
                .fold(0.0_f64, f64::max);
            let mut rows = vec![UsageRow {
                id_suffix: format!("{}:header", item.provider),
                text: truncate_row(format!(
                    "{} {}{stale_suffix}",
                    status_glyph(worst),
                    item.label
                )),
            }];
            let truncated = measurable.len() > max_limits;
            for (idx, entry) in measurable.iter().take(max_limits).enumerate() {
                let name = entry.name.as_deref().unwrap_or(&item.label);
                rows.push(UsageRow {
                    id_suffix: format!("{}:{idx}", item.provider),
                    text: truncate_row(format!(
                        "{GROUP_INDENT}{} {name} \u{00B7} {}",
                        entry.glyph, entry.suffix
                    )),
                });
            }
            if truncated {
                rows.push(UsageRow {
                    id_suffix: format!("{}:more", item.provider),
                    text: format!(
                        "{GROUP_INDENT}\u{2026} {} more",
                        measurable.len() - max_limits
                    ),
                });
            }
            rows
        }
    }
}

/// Build every dynamic tray row for the whole summary, in stable
/// provider order. Empty input means "no connected usage-capable
/// providers" — callers render a single explanatory placeholder row in
/// that case (kept out of this pure function so it stays trivially
/// testable without special-casing).
pub fn format_summary_rows(body: &UsageSummaryBody, now_unix: i64) -> Vec<UsageRow> {
    const MAX_LIMITS_PER_PROVIDER: usize = 3;
    body.items
        .iter()
        .flat_map(|item| format_item_rows(item, now_unix, MAX_LIMITS_PER_PROVIDER))
        .collect()
}

/// Footer row text summarising when the snapshot was taken.
pub fn format_footer(body: &UsageSummaryBody, now_unix: i64) -> String {
    if body.checked_at <= 0 {
        return "Not checked yet".to_string();
    }
    let age_s = (now_unix - body.checked_at).max(0);
    let age = if age_s < 60 {
        "just now".to_string()
    } else if age_s < 3600 {
        format!("{}m ago", age_s / 60)
    } else {
        format!("{}h ago", age_s / 3600)
    };
    // "(cached)" dropped — an implementation detail users don't act on.
    format!("Checked {age}")
}

/// Footer text when a refresh failed. With a previous snapshot the rows
/// stay rendered and the footer carries both the snapshot age and the
/// failure marker; with nothing cached the raw error is all we have.
pub fn format_failed_footer(previous: Option<&UsageSummaryBody>, now_unix: i64, error: &str) -> String {
    match previous {
        Some(body) if body.checked_at > 0 => {
            format!("\u{26A0} {} \u{00B7} refresh failed", format_footer(body, now_unix))
        }
        _ => format!("\u{26A0} Refresh failed: {error}"),
    }
}

/// Exponential backoff for the background poll loop after consecutive
/// failures (upstream outage, expired OAuth token, backend briefly
/// unreachable during a reload, …). Doubles per consecutive failure,
/// capped at `max_backoff` so a long-running app still recovers promptly
/// once the underlying issue clears rather than backing off forever.
/// `consecutive_failures == 0` (the healthy path) always returns `base`.
pub fn backoff_delay(base: Duration, consecutive_failures: u32, max_backoff: Duration) -> Duration {
    if consecutive_failures == 0 {
        return base;
    }
    let factor = 1u32 << consecutive_failures.min(16);
    base.saturating_mul(factor).min(max_backoff)
}

/// Usage percentage at/above which a provider is considered "critical" —
/// drives the tray badge and the one-shot native notification. Matches
/// the 🔴 glyph threshold in [`status_glyph`].
pub const CRITICAL_USAGE_PERCENT: f64 = 90.0;

fn item_is_critical(item: &UsageSummaryItem) -> bool {
    item.usage.as_ref().is_some_and(|usage| {
        usage.limits.iter().any(|limit| {
            let window_hot = [limit.primary.as_ref(), limit.secondary.as_ref()]
                .into_iter()
                .flatten()
                .any(|window| window.used_percent >= CRITICAL_USAGE_PERCENT);
            // A spend cap blocks requests just as hard as an exhausted
            // rate-limit window — and on a capped account it is often the
            // only signal, since upstream stops sending windows entirely.
            let spend_hot = limit.spend.as_ref().is_some_and(|spend| {
                spend.reached || spend_percent(spend) >= CRITICAL_USAGE_PERCENT
            });
            window_hot || spend_hot
        })
    })
}

/// Provider ids currently at/above the critical threshold. Stale
/// (last-known-good) items still count — the user is just as rate-limited
/// whether or not the latest poll succeeded.
pub fn critical_providers(body: &UsageSummaryBody) -> HashSet<String> {
    body.items
        .iter()
        .filter(|item| item_is_critical(item))
        .map(|item| item.provider.clone())
        .collect()
}

/// Whether any connected provider is at or above the "hot" usage
/// threshold — used to decide whether the tray should surface a subtle
/// warning affordance (see `menu.rs::update_tray_usage`).
pub fn has_critical_usage(body: &UsageSummaryBody) -> bool {
    body.items.iter().any(item_is_critical)
}

/// Compute which providers *newly crossed* the critical threshold since
/// the previous poll — these get a one-shot native notification. Returns
/// ``(providers_to_notify, next_notified_set)``.
///
/// Dedup rules:
/// - A provider already in ``previously_notified`` is never re-notified
///   while it stays critical (no notification spam every poll).
/// - A provider that drops below the threshold (quota window reset) is
///   removed from the notified set, re-arming its notification for the
///   next time it crosses.
pub fn notification_transitions(
    current_critical: &HashSet<String>,
    previously_notified: &HashSet<String>,
) -> (Vec<String>, HashSet<String>) {
    let mut to_notify: Vec<String> = current_critical
        .difference(previously_notified)
        .cloned()
        .collect();
    to_notify.sort(); // deterministic order for stable notification text
    // Providers no longer critical fall out; still-critical ones stay armed.
    let next: HashSet<String> = previously_notified
        .intersection(current_critical)
        .cloned()
        .chain(to_notify.iter().cloned())
        .collect();
    (to_notify, next)
}

/// Body text for the "usage limit almost reached" native notification.
pub fn format_notification_body(labels: &[String]) -> String {
    format!(
        "{} {} its usage limit. New requests may be rejected until the quota resets.",
        labels.join(", "),
        if labels.len() == 1 { "is near" } else { "are near" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_client_uses_platform_certificate_roots() {
        let manifest = std::fs::read_to_string(format!(
            "{}/Cargo.toml",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("read Cargo manifest");

        assert!(
            manifest.contains("rustls-tls-native-roots"),
            "external health checks must trust certificates installed in the platform trust store"
        );
    }

    fn item_ok(provider: &str, label: &str, used_percent: f64, resets_at: Option<i64>) -> UsageSummaryItem {
        UsageSummaryItem {
            provider: provider.to_string(),
            label: label.to_string(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse {
                provider: provider.to_string(),
                limits: vec![UsageLimit {
                    limit_id: Some(provider.to_string()),
                    limit_name: None,
                    primary: Some(UsageWindow {
                        used_percent,
                        window_minutes: Some(60),
                        resets_at,
                    }),
                    secondary: None,
                    credits: None,
                    spend: None,
                    plan_type: None,
                    rate_limit_reached_type: None,
                    period_start_at: None,
                    period_end_at: None,
                }],
            }),
        }
    }

    #[test]
    fn format_reset_in_covers_minutes_hours_days() {
        assert_eq!(format_reset_in(1_000, 1_030), "resetting");
        assert_eq!(format_reset_in(1_090, 1_000), "resets 1m");
        assert_eq!(format_reset_in(1_000 + 3600, 1_000), "resets 1h");
        assert_eq!(format_reset_in(1_000 + 3600 + 600, 1_000), "resets 1h 10m");
        assert_eq!(format_reset_in(1_000 + 86400 * 2, 1_000), "resets 2d");
    }

    #[test]
    fn glyph_thresholds_match_the_web_usage_panel() {
        assert_eq!(status_glyph(95.0), "\u{1F534}");
        assert_eq!(status_glyph(70.0), "\u{1F7E0}");
        assert_eq!(status_glyph(69.9), "\u{1F7E2}");
    }

    #[test]
    fn render_bar_fills_proportionally_and_clamps() {
        assert_eq!(render_bar(0.0), "\u{2591}".repeat(BAR_WIDTH));
        assert_eq!(render_bar(100.0), "\u{2588}".repeat(BAR_WIDTH));
        // 42% of 10 segments rounds to 4 filled, 6 empty.
        assert_eq!(render_bar(42.0), format!("{}{}", "\u{2588}".repeat(4), "\u{2591}".repeat(6)));
        // Out-of-range inputs (defensive: upstream already clamps
        // used_percent, but the renderer must never panic/overflow).
        assert_eq!(render_bar(-10.0), "\u{2591}".repeat(BAR_WIDTH));
        assert_eq!(render_bar(150.0), "\u{2588}".repeat(BAR_WIDTH));
    }

    #[test]
    fn format_limit_suffix_includes_the_bar_between_percent_and_reset() {
        let limit = UsageLimit {
            limit_id: Some("codex".to_string()),
            limit_name: None,
            primary: Some(UsageWindow {
                used_percent: 50.0,
                window_minutes: Some(60),
                resets_at: Some(2_000),
            }),
            secondary: None,
            credits: None,
            spend: None,
            plan_type: None,
            rate_limit_reached_type: None,
            period_start_at: None,
            period_end_at: None,
        };
        let (_, suffix) = format_limit_suffix(&limit, 1_000).expect("measurable limit");
        assert_eq!(suffix, format!("50% {} \u{00B7} resets 16m", render_bar(50.0)));
    }

    #[test]
    fn rows_render_one_line_per_connected_provider() {
        let body = UsageSummaryBody {
            items: vec![
                item_ok("codex", "OpenAI Codex", 42.0, Some(2_000)),
                item_ok("agy", "Antigravity Gemini Auth", 91.0, None),
            ],
            checked_at: 1_000,
            cached: false,
        };
        let rows = format_summary_rows(&body, 1_000);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].text.contains("OpenAI Codex"));
        assert!(rows[0].text.contains("42%"));
        assert!(rows[1].text.starts_with("\u{1F534}"));
    }

    #[test]
    fn period_only_limits_render_neutral_availability_without_unlimited_usage() {
        let item = UsageSummaryItem {
            provider: "grok".to_string(),
            label: "Grok".to_string(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse {
                provider: "grok".to_string(),
                limits: vec![UsageLimit {
                    limit_id: None,
                    limit_name: Some("Weekly usage period".to_string()),
                    primary: None,
                    secondary: None,
                    credits: None,
                    spend: None,
                    plan_type: None,
                    rate_limit_reached_type: None,
                    period_start_at: Some(1_000),
                    period_end_at: Some(1_000 + 6 * 86_400),
                }],
            }),
        };
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].text.contains("Weekly usage period"),
            "{}",
            rows[0].text
        );
        assert!(rows[0].text.contains("period available"), "{}", rows[0].text);
        assert!(rows[0].text.contains("ends 6d"), "{}", rows[0].text);
        assert!(!rows[0].text.contains("unlimited"), "{}", rows[0].text);
    }

    #[test]
    fn credentials_missing_and_unavailable_render_distinct_rows() {
        let body = UsageSummaryBody {
            items: vec![
                UsageSummaryItem {
                    provider: "claude".to_string(),
                    label: "Claude OAuth".to_string(),
                    status: "credentials_missing".to_string(),
                    error: Some("token missing".to_string()),
                    stale: false,
                    usage: None,
                },
                UsageSummaryItem {
                    provider: "copilot".to_string(),
                    label: "GitHub Copilot".to_string(),
                    status: "unavailable".to_string(),
                    error: Some("timeout".to_string()),
                    stale: false,
                    usage: None,
                },
            ],
            checked_at: 1_000,
            cached: false,
        };
        let rows = format_summary_rows(&body, 1_000);
        assert!(rows[0].text.contains("reconnect"));
        assert!(rows[1].text.contains("unavailable"));
    }

    #[test]
    fn empty_summary_produces_no_rows() {
        let body = UsageSummaryBody::default();
        assert!(format_summary_rows(&body, 1_000).is_empty());
    }

    #[test]
    fn footer_reports_relative_age_and_cache_state() {
        let body = UsageSummaryBody {
            items: vec![],
            checked_at: 1_000,
            cached: true,
        };
        // "(cached)" is deliberately not surfaced — implementation detail.
        assert_eq!(format_footer(&body, 1_000), "Checked just now");
        assert_eq!(format_footer(&body, 1_130), "Checked 2m ago");
        assert_eq!(
            format_footer(&UsageSummaryBody::default(), 1_000),
            "Not checked yet"
        );
    }

    #[test]
    fn backoff_delay_is_flat_when_healthy_and_doubles_per_failure() {
        let base = Duration::from_secs(300);
        let max = Duration::from_secs(1_800);
        assert_eq!(backoff_delay(base, 0, max), base);
        assert_eq!(backoff_delay(base, 1, max), Duration::from_secs(600));
        assert_eq!(backoff_delay(base, 2, max), Duration::from_secs(1_200));
        // Would be 2400s uncapped; clamps to the 1800s ceiling.
        assert_eq!(backoff_delay(base, 3, max), max);
        // Large failure counts must not overflow/panic — still capped.
        assert_eq!(backoff_delay(base, 1_000, max), max);
    }

    #[test]
    fn has_critical_usage_detects_hot_providers() {
        let hot = UsageSummaryBody {
            items: vec![item_ok("codex", "OpenAI Codex", 92.0, None)],
            checked_at: 1_000,
            cached: false,
        };
        let cool = UsageSummaryBody {
            items: vec![item_ok("codex", "OpenAI Codex", 10.0, None)],
            checked_at: 1_000,
            cached: false,
        };
        assert!(has_critical_usage(&hot));
        assert!(!has_critical_usage(&cool));
    }

    #[test]
    fn stale_items_render_a_last_known_marker() {
        let mut item = item_ok("codex", "OpenAI Codex", 42.0, Some(2_000));
        item.stale = true;
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].text.ends_with("(old)"),
            "stale row should carry the marker: {}",
            rows[0].text
        );
        // Fresh items must not carry the marker.
        let fresh = item_ok("codex", "OpenAI Codex", 42.0, Some(2_000));
        let rows = format_item_rows(&fresh, 1_000, 3);
        assert!(!rows[0].text.contains("(old)"));
    }

    #[test]
    fn failed_footer_keeps_snapshot_age_when_a_previous_snapshot_exists() {
        let body = UsageSummaryBody {
            items: vec![],
            checked_at: 1_000,
            cached: false,
        };
        let footer = format_failed_footer(Some(&body), 1_130, "connection refused");
        assert_eq!(footer, "\u{26A0} Checked 2m ago \u{00B7} refresh failed");
        // The raw error is deliberately NOT in the footer when we still
        // have numbers on screen — it's noise next to real data.
        assert!(!footer.contains("connection refused"));
    }

    #[test]
    fn failed_footer_surfaces_the_error_when_nothing_was_ever_fetched() {
        let footer = format_failed_footer(None, 1_000, "connection refused");
        assert!(footer.contains("connection refused"));
        // A zero checked_at (default body) is treated like no snapshot.
        let empty = UsageSummaryBody::default();
        let footer = format_failed_footer(Some(&empty), 1_000, "boom");
        assert!(footer.contains("boom"));
    }

    #[test]
    fn critical_providers_lists_only_hot_items_including_stale_ones() {
        let mut stale_hot = item_ok("agy", "Antigravity", 95.0, None);
        stale_hot.stale = true;
        let body = UsageSummaryBody {
            items: vec![
                item_ok("codex", "OpenAI Codex", 10.0, None),
                stale_hot,
                item_ok("claude", "Claude OAuth", 90.0, None), // exactly at threshold
            ],
            checked_at: 1_000,
            cached: false,
        };
        let critical = critical_providers(&body);
        assert!(!critical.contains("codex"));
        assert!(critical.contains("agy"), "stale-but-hot still counts");
        assert!(critical.contains("claude"), "exactly-at-threshold counts");
    }

    #[test]
    fn notification_fires_once_per_crossing_and_rearms_after_reset() {
        let notified = HashSet::new();

        // Poll 1: codex crosses → notify, remember.
        let critical: HashSet<String> = ["codex".to_string()].into();
        let (fire, notified) = notification_transitions(&critical, &notified);
        assert_eq!(fire, vec!["codex".to_string()]);

        // Poll 2: still critical → no re-notification.
        let (fire, notified) = notification_transitions(&critical, &notified);
        assert!(fire.is_empty(), "must not spam while still critical");

        // Poll 3: quota reset (below threshold) → re-armed, nothing fires.
        let cooled: HashSet<String> = HashSet::new();
        let (fire, notified) = notification_transitions(&cooled, &notified);
        assert!(fire.is_empty());
        assert!(notified.is_empty(), "reset must re-arm the provider");

        // Poll 4: crosses again → fires again.
        let (fire, _) = notification_transitions(&critical, &notified);
        assert_eq!(fire, vec!["codex".to_string()]);
    }

    #[test]
    fn notification_transitions_handle_multiple_providers_deterministically() {
        let notified: HashSet<String> = ["codex".to_string()].into();
        let critical: HashSet<String> =
            ["codex".to_string(), "claude".to_string(), "agy".to_string()].into();
        let (fire, next) = notification_transitions(&critical, &notified);
        // Only the newcomers fire, sorted for stable notification text.
        assert_eq!(fire, vec!["agy".to_string(), "claude".to_string()]);
        assert_eq!(next.len(), 3, "all critical providers stay tracked");
    }

    #[test]
    fn notification_body_reads_grammatically_for_one_and_many() {
        let one = format_notification_body(&["OpenAI Codex".to_string()]);
        assert!(one.starts_with("OpenAI Codex is near"));
        let two = format_notification_body(&[
            "OpenAI Codex".to_string(),
            "Claude OAuth".to_string(),
        ]);
        assert!(two.starts_with("OpenAI Codex, Claude OAuth are near"));
    }

    #[test]
    fn rate_limit_reached_is_surfaced_compactly() {
        let item = UsageSummaryItem {
            provider: "codex".to_string(),
            label: "OpenAI Codex".to_string(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse {
                provider: "codex".to_string(),
                limits: vec![UsageLimit {
                    limit_id: Some("codex".to_string()),
                    limit_name: None,
                    primary: Some(UsageWindow {
                        used_percent: 100.0,
                        window_minutes: Some(60),
                        resets_at: None,
                    }),
                    secondary: None,
                    credits: None,
                    spend: None,
                    plan_type: None,
                    rate_limit_reached_type: Some(
                        "workspace_member_usage_limit_reached".to_string(),
                    ),
                    period_start_at: None,
                    period_end_at: None,
                }],
            }),
        };
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 1);
        // Compact: the marker alone; the provider-specific reason string
        // stays in Settings → Providers, not the tray.
        assert!(rows[0].text.ends_with("LIMIT REACHED"), "{}", rows[0].text);
        assert!(!rows[0].text.contains("workspace_member"));
    }

    #[test]
    fn long_rows_are_truncated_with_an_ellipsis() {
        let very_long_name = "X".repeat(200);
        let item = UsageSummaryItem {
            provider: "codex".to_string(),
            label: very_long_name.clone(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse {
                provider: "codex".to_string(),
                limits: vec![UsageLimit {
                    limit_id: Some("codex".to_string()),
                    limit_name: Some(very_long_name),
                    primary: Some(UsageWindow {
                        used_percent: 10.0,
                        window_minutes: Some(60),
                        resets_at: None,
                    }),
                    secondary: None,
                    credits: None,
                    spend: None,
                    plan_type: None,
                    rate_limit_reached_type: None,
                    period_start_at: None,
                    period_end_at: None,
                }],
            }),
        };
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows[0].text.chars().count(), MAX_ROW_LEN);
        assert!(rows[0].text.ends_with('\u{2026}'));
    }

    #[test]
    fn extra_limits_beyond_the_cap_collapse_into_a_see_more_row() {
        let mut limits = Vec::new();
        for i in 0..5 {
            limits.push(UsageLimit {
                limit_id: Some(format!("limit-{i}")),
                limit_name: Some(format!("Limit {i}")),
                primary: Some(UsageWindow {
                    used_percent: 10.0,
                    window_minutes: Some(60),
                    resets_at: None,
                }),
                secondary: None,
                credits: None,
                spend: None,
                plan_type: None,
                rate_limit_reached_type: None,
                period_start_at: None,
                period_end_at: None,
            });
        }
        let item = UsageSummaryItem {
            provider: "codex".to_string(),
            label: "OpenAI Codex".to_string(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse { provider: "codex".to_string(), limits }),
        };
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 5); // header + 3 limits + "more" row
        assert!(rows[0].text.contains("OpenAI Codex"), "header row leads");
        assert!(
            rows.last().unwrap().text.contains("2 more"),
            "overflow row counts the hidden limits: {}",
            rows.last().unwrap().text
        );
    }

    #[test]
    fn single_limit_renders_one_flat_row_with_provider_label_first() {
        let mut item = item_ok("copilot", "GitHub Copilot", 12.0, None);
        item.usage.as_mut().unwrap().limits[0].limit_name =
            Some("Premium requests".to_string());
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].text.contains("GitHub Copilot \u{00B7} Premium requests \u{00B7} 12%"),
            "provider label must lead, then the limit name: {}",
            rows[0].text
        );
    }

    #[test]
    fn single_limit_omits_duplicate_or_missing_limit_name() {
        // limit_name == provider label → no "Codex · Codex" duplication.
        let mut item = item_ok("codex", "OpenAI Codex", 50.0, None);
        item.usage.as_mut().unwrap().limits[0].limit_name = Some("OpenAI Codex".to_string());
        let rows = format_item_rows(&item, 1_000, 3);
        assert!(rows[0].text.contains("OpenAI Codex \u{00B7} 50%"));
        assert_eq!(rows[0].text.matches("OpenAI Codex").count(), 1);
        // Missing limit_name → same flat shape.
        let item = item_ok("codex", "OpenAI Codex", 50.0, None);
        let rows = format_item_rows(&item, 1_000, 3);
        assert!(rows[0].text.contains("OpenAI Codex \u{00B7} 50%"));
    }

    #[test]
    fn multi_limit_provider_groups_under_a_header_with_worst_glyph() {
        let make_limit = |name: &str, used: f64| UsageLimit {
            limit_id: Some(name.to_string()),
            limit_name: Some(name.to_string()),
            primary: Some(UsageWindow {
                used_percent: used,
                window_minutes: Some(60),
                resets_at: None,
            }),
            secondary: None,
            credits: None,
            spend: None,
            plan_type: None,
            rate_limit_reached_type: None,
            period_start_at: None,
            period_end_at: None,
        };
        let item = UsageSummaryItem {
            provider: "agy".to_string(),
            label: "Antigravity Gemini".to_string(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse {
                provider: "agy".to_string(),
                limits: vec![
                    make_limit("Gemini 3.1 Pro (High)", 10.0),
                    make_limit("Claude Sonnet 4.6", 95.0),
                ],
            }),
        };
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 3); // header + 2 limits
        // Header carries the provider label and the WORST limit's glyph.
        assert!(rows[0].text.starts_with("\u{1F534} Antigravity Gemini"));
        // Limit rows are indented and do NOT repeat the provider label.
        assert!(rows[1].text.starts_with(GROUP_INDENT));
        assert!(rows[1].text.contains("Gemini 3.1 Pro (High) \u{00B7} 10%"));
        assert!(!rows[1].text.contains("Antigravity Gemini"));
        assert!(rows[2].text.contains("Claude Sonnet 4.6 \u{00B7} 95%"));
    }

    #[test]
    fn stale_marker_lands_on_the_header_for_grouped_providers() {
        let mut item = item_ok("codex", "OpenAI Codex", 10.0, None);
        // Grow to two limits so the grouped path is taken.
        let extra = item.usage.as_ref().unwrap().limits[0].clone();
        item.usage.as_mut().unwrap().limits.push(extra);
        item.stale = true;
        let rows = format_item_rows(&item, 1_000, 3);
        assert!(
            rows[0].text.contains("(old)"),
            "header should carry the stale marker: {}",
            rows[0].text
        );
        assert!(
            !rows[1].text.contains("(old)"),
            "indented rows should not repeat it: {}",
            rows[1].text
        );
    }

    /// The captured shape of a business account over its workspace spend
    /// cap: Codex stops sending rate-limit windows entirely, so the cap is
    /// the only usage signal left (see
    /// `tests/agent/providers/codex/test_usage.py`).
    fn codex_spend_capped_item() -> UsageSummaryItem {
        UsageSummaryItem {
            provider: "codex".to_string(),
            label: "OpenAI Codex".to_string(),
            status: "ok".to_string(),
            error: None,
            stale: false,
            usage: Some(UsageResponse {
                provider: "codex".to_string(),
                limits: vec![UsageLimit {
                    limit_id: Some("codex".to_string()),
                    limit_name: None,
                    primary: None,
                    secondary: None,
                    credits: Some(UsageCredits {
                        // Still true while the account is hard-blocked.
                        has_credits: true,
                        unlimited: false,
                        balance: None,
                    }),
                    spend: Some(UsageSpend {
                        reached: true,
                        source: Some("workspace_spend_controls".to_string()),
                        limit: Some(700.0),
                        used: Some(1811.965924501419),
                        remaining: Some(0.0),
                        used_percent: Some(259.0),
                        resets_at: Some(1_000 + 2 * 86_400),
                    }),
                    plan_type: Some("business".to_string()),
                    rate_limit_reached_type: Some(
                        "workspace_member_usage_limit_reached".to_string(),
                    ),
                    period_start_at: None,
                    period_end_at: None,
                }],
            }),
        }
    }

    #[test]
    fn format_amount_groups_thousands_and_trims_trailing_zeros() {
        assert_eq!(format_amount(1811.965924501419), "1,811.97");
        assert_eq!(format_amount(700.0), "700");
        assert_eq!(format_amount(0.0), "0");
        assert_eq!(format_amount(12.5), "12.5");
        assert_eq!(format_amount(1_234_567.0), "1,234,567");
    }

    #[test]
    fn spend_capped_provider_shows_the_cap_instead_of_claiming_credits() {
        let rows = format_item_rows(&codex_spend_capped_item(), 1_000, 3);
        assert_eq!(rows.len(), 1, "one measurement, one flat row: {rows:?}");
        let text = &rows[0].text;
        assert_eq!(
            *text,
            format!(
                "\u{1F534} OpenAI Codex \u{00B7} Spend cap \u{00B7} 259% {} \u{00B7} resets 2d \u{00B7} 1,811.97 of 700 used",
                render_bar(259.0)
            )
        );
        // The old rendering advertised credits on a blocked account.
        assert!(!text.contains("credits available"), "{text}");
        // The bar clamps, the percent does not.
        assert!(text.contains(&"\u{2588}".repeat(BAR_WIDTH)), "{text}");
        assert!(text.chars().count() <= MAX_ROW_LEN, "{text}");
    }

    #[test]
    fn a_reached_spend_cap_is_critical_for_the_badge_and_notification() {
        let body = UsageSummaryBody {
            items: vec![codex_spend_capped_item()],
            checked_at: 1_000,
            cached: false,
        };
        assert!(has_critical_usage(&body));
        assert!(critical_providers(&body).contains("codex"));
    }

    #[test]
    fn a_spend_cap_renders_alongside_a_rate_limit_window() {
        let mut item = codex_spend_capped_item();
        {
            let limit = &mut item.usage.as_mut().unwrap().limits[0];
            limit.primary = Some(UsageWindow {
                used_percent: 12.0,
                window_minutes: Some(300),
                resets_at: None,
            });
            limit.limit_name = Some("Codex".to_string());
        }
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 3, "header + window + spend cap: {rows:?}");
        // A cap is orthogonal to the window: the header takes the cap's
        // red even though the window sits at 12%.
        assert!(rows[0].text.starts_with("\u{1F534} OpenAI Codex"), "{}", rows[0].text);
        assert!(rows[1].text.contains("Codex \u{00B7} 12%"), "{}", rows[1].text);
        assert!(
            rows[2].text.contains("Codex \u{00B7} Spend cap \u{00B7} 259%"),
            "{}",
            rows[2].text
        );
    }

    #[test]
    fn a_reached_cap_without_amounts_corrects_the_credits_row() {
        let mut item = codex_spend_capped_item();
        // `reached` with no configured individual limit: nothing to meter,
        // so the credits row must carry the truth instead.
        item.usage.as_mut().unwrap().limits[0].spend = Some(UsageSpend {
            reached: true,
            source: None,
            limit: None,
            used: None,
            remaining: None,
            used_percent: None,
            resets_at: None,
        });
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "\u{1F534} OpenAI Codex \u{00B7} usage limit reached");
    }

    #[test]
    fn an_unbreached_cap_reports_headroom_without_a_red_glyph() {
        let mut item = codex_spend_capped_item();
        item.usage.as_mut().unwrap().limits[0].rate_limit_reached_type = None;
        item.usage.as_mut().unwrap().limits[0].spend = Some(UsageSpend {
            reached: false,
            source: Some("workspace_spend_controls".to_string()),
            limit: Some(700.0),
            used: Some(84.0),
            remaining: Some(616.0),
            used_percent: Some(12.0),
            resets_at: None,
        });
        let rows = format_item_rows(&item, 1_000, 3);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].text.starts_with("\u{1F7E2}"), "{}", rows[0].text);
        assert!(rows[0].text.contains("12% "), "{}", rows[0].text);
        assert!(rows[0].text.contains("84 of 700 used"), "{}", rows[0].text);
    }

    #[test]
    fn providers_without_spend_data_render_unchanged() {
        // Guardrail for the entry refactor: a plain window provider must
        // still collapse to one flat row with no spend wording.
        let rows = format_item_rows(&item_ok("codex", "OpenAI Codex", 42.0, Some(2_000)), 1_000, 3);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].text.contains(SPEND_LABEL), "{}", rows[0].text);
    }
}
