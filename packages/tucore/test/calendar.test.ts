import { describe, expect, it } from 'vitest';
import {
  countTradingDays,
  etDate,
  etMsFromParts,
  etParts,
  isEarlyCloseDate,
  isHoliday,
  isTradingDay,
  isWeekend,
  nextSession,
  sessionKindAt,
  sessionTimes,
  tradingDaysBetween,
} from '../src/calendar.ts';

describe('calendar', () => {
  it('Saturday/Sunday -> WEEKEND', () => {
    expect(sessionKindAt(etMsFromParts(2026, 4, 4, 10, 0))).toBe('WEEKEND');
    expect(sessionKindAt(etMsFromParts(2026, 4, 5, 10, 0))).toBe('WEEKEND');
    expect(isWeekend('2026-04-04')).toBe(true);
    expect(isWeekend('2026-04-05')).toBe(true);
    expect(isWeekend('2026-04-06')).toBe(false);
    expect(etParts(etMsFromParts(2026, 4, 4, 12, 0)).weekday).toBe(6);
    expect(etParts(etMsFromParts(2026, 4, 5, 12, 0)).weekday).toBe(0);
  });

  it('Good Friday 2026-04-03 -> HOLIDAY (whole day)', () => {
    expect(isHoliday('2026-04-03')).toBe(true);
    expect(isTradingDay('2026-04-03')).toBe(false);
    expect(sessionKindAt(etMsFromParts(2026, 4, 3, 10, 0))).toBe('HOLIDAY');
    expect(sessionKindAt(etMsFromParts(2026, 4, 3, 18, 0))).toBe('HOLIDAY');
    expect(sessionTimes('2026-04-03')).toBeNull();
  });

  it('Thanksgiving 2026-11-26 -> HOLIDAY', () => {
    expect(isHoliday('2026-11-26')).toBe(true);
    expect(sessionKindAt(etMsFromParts(2026, 11, 26, 10, 0))).toBe('HOLIDAY');
    expect(sessionTimes('2026-11-26')).toBeNull();
  });

  it('observed-day holiday entries (Sat->Fri, Sun->Mon)', () => {
    expect(isHoliday('2026-07-03')).toBe(true); // Jul 4 2026 = Sat
    expect(isHoliday('2026-07-04')).toBe(false); // Saturday itself
    expect(isHoliday('2027-06-18')).toBe(true); // Jun 19 2027 = Sat
    expect(isHoliday('2027-07-05')).toBe(true); // Jul 4 2027 = Sun
    expect(isHoliday('2027-12-24')).toBe(true); // Dec 25 2027 = Sat
    expect(isHoliday('2028-01-03')).toBe(true); // Jan 1 2028 = Sat
    expect(isHoliday('2028-12-26')).toBe(true); // Dec 25 2028 = Sun
    expect(isHoliday('2026-12-25')).toBe(true);
    expect(isHoliday('2025-04-18')).toBe(true); // Good Friday 2025
  });

  it('early closes: day after Thanksgiving + Christmas Eve', () => {
    expect(isEarlyCloseDate('2026-11-27')).toBe(true);
    expect(isEarlyCloseDate('2026-12-24')).toBe(true);
    expect(isEarlyCloseDate('2024-11-29')).toBe(true);
    expect(isEarlyCloseDate('2024-12-24')).toBe(true);
    expect(isEarlyCloseDate('2028-11-24')).toBe(true);
    expect(isEarlyCloseDate('2028-12-22')).toBe(true);
    expect(isEarlyCloseDate('2026-11-26')).toBe(false); // holiday, not early close
  });

  it('2026-11-27 session closes 13:00 ET; 14:00 ET is POSTMARKET', () => {
    const st = sessionTimes('2026-11-27');
    expect(st).not.toBeNull();
    expect(st!.earlyClose).toBe(true);
    expect(st!.openMs).toBe(etMsFromParts(2026, 11, 27, 9, 30));
    expect(st!.closeMs).toBe(etMsFromParts(2026, 11, 27, 13, 0));
    expect(sessionKindAt(etMsFromParts(2026, 11, 27, 10, 0))).toBe('EARLY_CLOSE');
    expect(sessionKindAt(etMsFromParts(2026, 11, 27, 12, 59))).toBe('EARLY_CLOSE');
    expect(sessionKindAt(etMsFromParts(2026, 11, 27, 13, 0))).toBe('POSTMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 11, 27, 14, 0))).toBe('POSTMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 11, 27, 20, 0))).toBe('MARKET_CLOSED');
  });

  it('regular Monday session boundaries (2026-06-15)', () => {
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 3, 0))).toBe('MARKET_CLOSED');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 4, 0))).toBe('PREMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 7, 0))).toBe('PREMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 9, 29))).toBe('PREMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 9, 30))).toBe('MARKET_OPEN');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 10, 0))).toBe('MARKET_OPEN');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 15, 59))).toBe('MARKET_OPEN');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 16, 0))).toBe('POSTMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 17, 0))).toBe('POSTMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 19, 59))).toBe('POSTMARKET');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 20, 0))).toBe('MARKET_CLOSED');
    expect(sessionKindAt(etMsFromParts(2026, 6, 15, 21, 0))).toBe('MARKET_CLOSED');
    const st = sessionTimes('2026-06-15');
    expect(st!.earlyClose).toBe(false);
    expect(st!.closeMs).toBe(Date.UTC(2026, 5, 15, 20, 0)); // 16:00 EDT
  });

  it('DST: summer 10:00 ET = 14:00Z, winter 10:00 ET = 15:00Z', () => {
    const summer = etMsFromParts(2026, 7, 1, 10, 0);
    const winter = etMsFromParts(2026, 1, 15, 10, 0);
    expect(summer).toBe(Date.UTC(2026, 6, 1, 14, 0)); // EDT = UTC-4
    expect(winter).toBe(Date.UTC(2026, 0, 15, 15, 0)); // EST = UTC-5
    expect(sessionKindAt(summer)).toBe('MARKET_OPEN');
    expect(sessionKindAt(winter)).toBe('MARKET_OPEN');
    expect(etParts(summer)).toMatchObject({ year: 2026, month: 7, day: 1, hour: 10, minute: 0 });
    expect(etParts(winter)).toMatchObject({ year: 2026, month: 1, day: 15, hour: 10, minute: 0 });
  });

  it('DST gaps map forward, fall-back resolves to the first occurrence', () => {
    // 02:30 ET on 2026-03-08 does not exist (spring forward 02:00 -> 03:00)
    const gap = etMsFromParts(2026, 3, 8, 2, 30);
    expect(gap).toBe(Date.UTC(2026, 2, 8, 7, 30)); // 03:30 EDT, shifted forward
    expect(etDate(gap)).toBe('2026-03-08');
    // 01:30 ET on 2026-11-01 exists twice; first (EDT) occurrence wins
    expect(etMsFromParts(2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(etDate(Date.UTC(2026, 5, 15, 14, 0))).toBe('2026-06-15');
    expect(etDate(Date.UTC(2026, 0, 15, 15, 0))).toBe('2026-01-15');
  });

  it('etParts/etDate round-trip across instants', () => {
    const ms = Date.UTC(2027, 2, 10, 17, 45); // March 10 is before DST (2nd Sunday) -> EST = UTC-5
    expect(etParts(ms)).toMatchObject({ year: 2027, month: 3, day: 10, hour: 12, minute: 45 });
    expect(etDate(ms)).toBe('2027-03-10');
    const afterDst = Date.UTC(2027, 2, 20, 17, 45); // after DST -> EDT = UTC-4
    expect(etParts(afterDst)).toMatchObject({ year: 2027, month: 3, day: 20, hour: 13, minute: 45 });
  });

  it('nextSession: Friday evening -> Monday, Friday morning -> same Friday', () => {
    const fridayEvening = nextSession(etMsFromParts(2026, 6, 12, 17, 0));
    expect(fridayEvening.date).toBe('2026-06-15');
    expect(fridayEvening.openMs).toBe(etMsFromParts(2026, 6, 15, 9, 30));
    expect(fridayEvening.earlyClose).toBe(false);
    expect(nextSession(etMsFromParts(2026, 6, 12, 8, 0)).date).toBe('2026-06-12');
    expect(nextSession(etMsFromParts(2026, 6, 13, 10, 0)).date).toBe('2026-06-15'); // Saturday
    const holidayEve = nextSession(etMsFromParts(2026, 11, 26, 17, 0)); // Thanksgiving evening
    expect(holidayEve.date).toBe('2026-11-27');
    expect(holidayEve.earlyClose).toBe(true);
    expect(holidayEve.closeMs).toBe(etMsFromParts(2026, 11, 27, 13, 0));
    // mid-session today rolls to the next trading day
    expect(nextSession(etMsFromParts(2026, 6, 15, 12, 0)).date).toBe('2026-06-16');
  });

  it('tradingDaysBetween counts inclusively and skips weekends/holidays', () => {
    expect(tradingDaysBetween('2026-06-15', '2026-06-19')).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
    ]); // Jun 19 = Juneteenth
    expect(countTradingDays('2026-01-01', '2026-01-31')).toBe(20);
    expect(countTradingDays('2026-06-19', '2026-06-19')).toBe(0);
    expect(tradingDaysBetween('2026-06-20', '2026-06-19')).toEqual([]);
    expect(countTradingDays('2026-11-23', '2026-11-27')).toBe(4); // Thanksgiving holiday
  });
});