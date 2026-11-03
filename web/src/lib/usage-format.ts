/**
 * How a provider's usage amounts are written: money in its currency when the
 * provider names a real ISO 4217 code, a bare number for any other unit.
 * Shared by Settings → Providers and the run picker, so both read the same.
 */
const amountFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const moneyFormatters = new Map<string, Intl.NumberFormat | null>()

/** A formatter only for a real ISO 4217 code; anything else is an unknown unit and stays a bare number. */
export function moneyFormatter(currency?: string | null): Intl.NumberFormat | null {
  if (!currency || !/^[A-Za-z]{3}$/.test(currency)) return null
  const code = currency.toUpperCase()
  if (!moneyFormatters.has(code)) {
    try {
      moneyFormatters.set(code, new Intl.NumberFormat('en-US', { style: 'currency', currency: code }))
    } catch {
      moneyFormatters.set(code, null)
    }
  }
  return moneyFormatters.get(code) ?? null
}

/** `$12.40` for a known currency, `12.4` for an unknown unit. */
export function formatUsageAmount(value: number, currency?: string | null): string {
  const money = moneyFormatter(currency)
  return money ? money.format(value) : amountFormatter.format(value)
}
