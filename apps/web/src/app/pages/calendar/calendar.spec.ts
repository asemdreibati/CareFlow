import { resetClinicTimeZone } from '../../core/i18n/locale-registry';
import { describe, expect, it, beforeEach } from 'vitest';
import { HOUR_PX, layoutDay } from './calendar';
import { Appointment } from '../../core/models';

// These specs assume the runtime time zone: clear any clinic zone left by other specs.
beforeEach(() => resetClinicTimeZone());

const appt = (id: string, start: string, end: string): Appointment =>
  ({ id, doctorId: 'd', patientId: 'p', startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), status: 'SCHEDULED', createdAt: '', updatedAt: '' }) as Appointment;

describe('layoutDay', () => {
  it('positions events relative to 07:00 and scales height by duration', () => {
    const [ev] = layoutDay([appt('a', '2026-10-04T09:00', '2026-10-04T10:00')]);
    expect(ev.top).toBe(2 * HOUR_PX);
    expect(ev.height).toBe(HOUR_PX - 2);
    expect(ev.cols).toBe(1);
  });
  it('splits overlapping events into columns', () => {
    const evs = layoutDay([
      appt('a', '2026-10-04T09:00', '2026-10-04T10:00'),
      appt('b', '2026-10-04T09:30', '2026-10-04T10:30'),
      appt('c', '2026-10-04T11:00', '2026-10-04T11:30'),
    ]);
    const byId = Object.fromEntries(evs.map((e) => [e.a.id, e]));
    expect(byId['a'].col).toBe(0);
    expect(byId['b'].col).toBe(1);
    expect(byId['a'].cols).toBe(2);
    expect(byId['c'].cols).toBe(1);
  });
});
