import { describe, expect, it } from 'vitest';
import { bookingLimits, isOnSlotGrid, portalMessage } from './portal-booking.js';

// 09:00-17:00 every day, 30-minute slots, plus a 15-minute afternoon block on Mondays.
const blocks = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '13:00', slotMinutes: 30 }));
blocks.push({ weekday: 1, startTime: '14:10', endTime: '17:00', slotMinutes: 15 });
const tz = 'Asia/Riyadh'; // UTC+3, no DST

describe('isOnSlotGrid', () => {
  it('accepts starts on the block grid', () => {
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T06:00:00.000Z'), tz)).toBe(true); // 09:00
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T07:30:00.000Z'), tz)).toBe(true); // 10:30
    expect(isOnSlotGrid(blocks, new Date('2026-10-12T11:25:00.000Z'), tz)).toBe(true); // Monday 14:25 (14:10 + 15)
  });

  it('rejects misaligned starts (the reviewer booked 10:07)', () => {
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T07:07:00.000Z'), tz)).toBe(false);
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T07:15:00.000Z'), tz)).toBe(false); // 30-min grid
    expect(isOnSlotGrid(blocks, new Date('2026-10-12T11:30:00.000Z'), tz)).toBe(false); // Monday 14:30 is not 14:10 + n*15
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T07:00:30.000Z'), tz)).toBe(false);
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T07:00:00.500Z'), tz)).toBe(false);
  });

  it('leaves starts outside availability to the availability check', () => {
    expect(isOnSlotGrid(blocks, new Date('2026-10-13T17:07:00.000Z'), tz)).toBe(true);
  });
});

describe('bookingLimits', () => {
  it('defaults to 3 active bookings and a 90-day horizon', () => {
    expect(bookingLimits({})).toEqual({ maxActiveBookings: 3, horizonDays: 90 });
    expect(bookingLimits(null)).toEqual({ maxActiveBookings: 3, horizonDays: 90 });
  });
  it('reads clinic.settings and ignores invalid values', () => {
    expect(bookingLimits({ portalMaxActiveBookings: 5, portalBookingHorizonDays: 30 })).toEqual({ maxActiveBookings: 5, horizonDays: 30 });
    expect(bookingLimits({ portalMaxActiveBookings: '2', portalBookingHorizonDays: '14' })).toEqual({ maxActiveBookings: 2, horizonDays: 14 });
    expect(bookingLimits({ portalMaxActiveBookings: 0, portalBookingHorizonDays: -1 })).toEqual({ maxActiveBookings: 3, horizonDays: 90 });
    expect(bookingLimits({ portalMaxActiveBookings: 2.5, portalBookingHorizonDays: 'soon' })).toEqual({ maxActiveBookings: 3, horizonDays: 90 });
  });
});

describe('portalMessage', () => {
  it('is localised', () => {
    expect(portalMessage('tooManyBookings', 'en', { max: 3 })).toContain('3 upcoming appointments');
    expect(portalMessage('tooManyBookings', 'ar', { max: 3 })).toContain('3');
    expect(portalMessage('beyondHorizon', 'en', { days: 90 })).toContain('90 days');
    expect(portalMessage('cancelTooLate', 'en')).toContain('2 hours');
    expect(portalMessage('offGrid', 'ar')).not.toBe(portalMessage('offGrid', 'en'));
  });
});
