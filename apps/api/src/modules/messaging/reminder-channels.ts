import type { ReminderChannel } from '@prisma/client';

const ALL: readonly ReminderChannel[] = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'];

/**
 * Channels a clinic reminds patients on (pure). `clinic.settings.reminderChannels`
 * wins when it is a non-empty list of known channels; otherwise the default is
 * in-app + SMS for patients with a phone and in-app + email for the rest.
 */
export function reminderChannelsFor(settings: unknown, hasPhone: boolean): ReminderChannel[] {
  const raw = (settings as { reminderChannels?: unknown } | null | undefined)?.reminderChannels;
  if (Array.isArray(raw)) {
    const picked = [...new Set(raw.map((c) => String(c).toUpperCase()).filter((c): c is ReminderChannel => (ALL as readonly string[]).includes(c)))];
    if (picked.length > 0) return picked;
  }
  return hasPhone ? ['IN_APP', 'SMS'] : ['IN_APP', 'EMAIL'];
}

/** Reminder schedule per channel: in-app 24h and 2h before, external channels 24h before. */
export function reminderPlanFor(channels: readonly ReminderChannel[]): { channel: ReminderChannel; hoursBefore: number }[] {
  const plan: { channel: ReminderChannel; hoursBefore: number }[] = [];
  for (const channel of channels) {
    plan.push({ channel, hoursBefore: 24 });
    if (channel === 'IN_APP') plan.push({ channel, hoursBefore: 2 });
  }
  return plan;
}
