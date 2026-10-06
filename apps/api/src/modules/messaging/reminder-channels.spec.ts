import { describe, expect, it } from 'vitest';
import { reminderChannelsFor, reminderPlanFor } from './reminder-channels.js';

describe('reminderChannelsFor', () => {
  it('defaults to in-app + SMS when the patient has a phone, in-app + email otherwise', () => {
    expect(reminderChannelsFor({}, true)).toEqual(['IN_APP', 'SMS']);
    expect(reminderChannelsFor(null, false)).toEqual(['IN_APP', 'EMAIL']);
    expect(reminderChannelsFor(undefined, true)).toEqual(['IN_APP', 'SMS']);
  });

  it('honours clinic settings and drops unknown entries', () => {
    expect(reminderChannelsFor({ reminderChannels: ['WHATSAPP', 'in_app', 'bogus', 'WHATSAPP'] }, true)).toEqual(['WHATSAPP', 'IN_APP']);
    expect(reminderChannelsFor({ reminderChannels: ['bogus'] }, false)).toEqual(['IN_APP', 'EMAIL']);
    expect(reminderChannelsFor({ reminderChannels: 'SMS' }, false)).toEqual(['IN_APP', 'EMAIL']);
  });
});

describe('reminderPlanFor', () => {
  it('schedules in-app twice and external channels once', () => {
    expect(reminderPlanFor(['IN_APP', 'SMS'])).toEqual([
      { channel: 'IN_APP', hoursBefore: 24 },
      { channel: 'IN_APP', hoursBefore: 2 },
      { channel: 'SMS', hoursBefore: 24 },
    ]);
    expect(reminderPlanFor([])).toEqual([]);
  });
});
