/**
 * NYSE and Nasdaq calendar for the tokenized-stock session labels. Ondo prices follow the US
 * session, so the pair list says whether the market is open. Dates are New York days (`YYYY-MM-DD`).
 *
 * This covers 2026 only. Outside it the session falls back to plain weekday hours, so extend the
 * lists each year from the exchange's published holiday schedule.
 */
export const US_MARKET_HOLIDAYS: readonly string[] = [
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
];

/** Days the regular session ends at 13:00 ET. */
export const US_MARKET_EARLY_CLOSES: readonly string[] = ["2026-11-27", "2026-12-24"];
