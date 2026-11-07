/**
 * NYSE trading calendar.
 *
 * All wall-clock reasoning is done in America/New_York via
 * Intl.DateTimeFormat, so DST transitions are handled correctly — never a
 * fixed UTC offset. The holiday table is hardcoded for 2024..2028 using the
 * documented observed-day conventions (Saturday -> observed Friday, Sunday ->
 * observed Monday, except when that would collide with another holiday; the
 * table entries are authoritative).
 */
import type { SessionKind } from './types.ts';

const ET_TIME_ZONE = 'America/New_York';

export interface EtParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  weekday: number; // 0=Sunday .. 6=Saturday
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** ET-local calendar/time parts for an instant. */
export function etParts(ms: number): EtParts {
  const parts = partsFormatter.formatToParts(new Date(ms));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    const value = Number(part.value);
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value;
    else if (part.type === 'minute') minute = value;
  }
  if (hour === 24) hour = 0; // some ICU versions emit 24 for midnight
  // Weekday is a property of the calendar date itself, so deriving it from a
  // UTC-midnight Date for the same Y-M-D is exact.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

/** ET session date 'YYYY-MM-DD' for an instant. */
export function etDate(ms: number): string {
  const p = etParts(ms);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Inverse of etParts: epoch ms for an ET wall-clock time.
 *
 * DST gaps (spring forward) are handled by comparing formatted parts: a wall
 * time that does not exist maps to the instant shifted forward by the gap
 * (e.g. 2026-03-08 02:30 ET -> 03:30 ET). DST overlaps (fall back) resolve to
 * the first (earlier) occurrence.
 */
export function etMsFromParts(year: number, month: number, day: number, hour: number, minute: number): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target; // first guess: treat the requested wall time as UTC
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = etParts(guess);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (got === target) return guess;
    guess += target - got;
  }
  return guess; // DST gap: forward-shifted instant (see doc comment)
}

function parseDate(date: string): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function weekdayOfDate(date: string): number {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextCalendarDate(date: string): string {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day) + 86400000).toISOString().slice(0, 10);
}

const HOLIDAYS_BY_YEAR: Record<number, readonly string[]> = {
  // 2024: New Year, MLK, Presidents' Day, Good Friday, Memorial, Juneteenth,
  // Independence, Labor, Thanksgiving, Christmas.
  2024: ['2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25'],
  2025: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
  // 2026: Jul 4 is Saturday -> observed Fri Jul 3.
  2026: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  // 2027: Jun 19 Saturday -> observed Fri Jun 18; Jul 4 Sunday -> observed
  // Mon Jul 5; Dec 25 Saturday -> observed Fri Dec 24.
  2027: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
  // 2028: Jan 1 Saturday -> observed Mon Jan 3; Dec 25 Sunday -> observed
  // Mon Dec 26.
  2028: ['2028-01-03', '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-26'],
};

const EARLY_CLOSES_BY_YEAR: Record<number, readonly string[]> = {
  2024: ['2024-11-29', '2024-12-24'],
  2025: ['2025-11-28', '2025-12-24'],
  2026: ['2026-11-27', '2026-12-24'],
  2027: ['2027-11-26', '2027-12-24'],
  2028: ['2028-11-24', '2028-12-22'],
};

const HOLIDAY_SET: ReadonlySet<string> = new Set(
  Object.values(HOLIDAYS_BY_YEAR).flatMap((list) => [...list]),
);
const EARLY_CLOSE_SET: ReadonlySet<string> = new Set(
  Object.values(EARLY_CLOSES_BY_YEAR).flatMap((list) => [...list]),
);

export function isWeekend(date: string): boolean {
  const wd = weekdayOfDate(date);
  return wd === 0 || wd === 6;
}

export function isHoliday(date: string): boolean {
  return HOLIDAY_SET.has(date); // years outside 2024..2028 are not in the table
}

export function isEarlyCloseDate(date: string): boolean {
  return EARLY_CLOSE_SET.has(date);
}

export function isTradingDay(date: string): boolean {
  return !isWeekend(date) && !isHoliday(date);
}

/**
 * Session kind at an instant (ET-local).
 *
 * Trading day: <04:00 MARKET_CLOSED, 04:00-09:30 PREMARKET, 09:30-16:00
 * MARKET_OPEN (early-close day: 09:30-13:00 EARLY_CLOSE, 13:00-16:00
 * POSTMARKET), 16:00-20:00 POSTMARKET (early-close day: 13:00-20:00
 * POSTMARKET), >=20:00 MARKET_CLOSED.
 */
export function sessionKindAt(ms: number): SessionKind {
  const p = etParts(ms);
  const date = etDate(ms);
  if (p.weekday === 0 || p.weekday === 6) return 'WEEKEND';
  if (isHoliday(date)) return 'HOLIDAY';
  const minutes = p.hour * 60 + p.minute;
  if (minutes < 4 * 60) return 'MARKET_CLOSED';
  if (minutes < 9 * 60 + 30) return 'PREMARKET';
  if (minutes < 16 * 60) {
    if (isEarlyCloseDate(date)) return minutes < 13 * 60 ? 'EARLY_CLOSE' : 'POSTMARKET';
    return 'MARKET_OPEN';
  }
  if (minutes < 20 * 60) return 'POSTMARKET';
  return 'MARKET_CLOSED';
}

export interface SessionTimes {
  openMs: number;
  closeMs: number;
  earlyClose: boolean;
}

/** Regular 09:30->16:00 ET (early 09:30->13:00 ET) session times, or null on non-trading days. */
export function sessionTimes(date: string): SessionTimes | null {
  if (!isTradingDay(date)) return null;
  const { year, month, day } = parseDate(date);
  const early = isEarlyCloseDate(date);
  return {
    openMs: etMsFromParts(year, month, day, 9, 30),
    closeMs: etMsFromParts(year, month, day, early ? 13 : 16, 0),
    earlyClose: early,
  };
}

export interface NextSession extends SessionTimes {
  date: string;
}

/**
 * Next session at or after an instant: today if today trades and the instant
 * is before today's open, otherwise the next trading day.
 */
export function nextSession(fromMs: number): NextSession {
  const date = etDate(fromMs);
  if (isTradingDay(date)) {
    const st = sessionTimes(date);
    if (st !== null && fromMs < st.openMs) return { date, ...st };
  }
  let next = nextCalendarDate(date);
  while (!isTradingDay(next)) next = nextCalendarDate(next);
  const st = sessionTimes(next);
  return { date: next, openMs: st!.openMs, closeMs: st!.closeMs, earlyClose: st!.earlyClose };
}

/** Trading days in [fromDate, toDate], inclusive, ascending. */
export function tradingDaysBetween(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  if (fromDate > toDate) return out;
  let cur = fromDate;
  while (cur <= toDate) {
    if (isTradingDay(cur)) out.push(cur);
    cur = nextCalendarDate(cur);
  }
  return out;
}

export function countTradingDays(fromDate: string, toDate: string): number {
  return tradingDaysBetween(fromDate, toDate).length;
}