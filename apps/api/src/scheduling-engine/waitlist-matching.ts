/**
 * Waitlist matching (pure, no Nest/Prisma): which entries admit a freed slot and
 * in which order they should be offered it.
 *
 * Ordering is a strict priority queue: URGENT before SOON before ROUTINE, then
 * the longest-waiting entry (createdAt ascending), then id for determinism.
 */
import { hhmmToMinutes, zonedParts } from '../modules/appointments/scheduling.js';
import { BinaryHeap } from './heap.js';
import { enumerateSlots } from './intervals.js';

export type WaitlistPriorityKey = 'URGENT' | 'SOON' | 'ROUTINE';

export const PRIORITY_RANK: Readonly<Record<WaitlistPriorityKey, number>> = { URGENT: 0, SOON: 1, ROUTINE: 2 };

/** Acceptable weekly window, wall-clock in the clinic timezone (same shape as availability blocks). */
export interface PreferredWindow {
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface WaitlistCandidate {
  id: string;
  priority: WaitlistPriorityKey;
  createdAt: Date;
  durationMinutes: number;
  /** The appointment must start at or after this instant. */
  earliestAt: Date;
  /** When set, the appointment must END at or before this instant. */
  latestAt: Date | null;
  /** Empty = any time. */
  preferredWindows: readonly PreferredWindow[];
}

export interface SlotRange {
  startsAt: Date;
  endsAt: Date;
}

/** Negative when `a` should be offered a slot before `b`. */
export function compareEntries(a: WaitlistCandidate, b: WaitlistCandidate): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * True when an appointment of the entry's duration placed at `slot.startsAt`
 * satisfies the entry: it fits in the slot, lies inside [earliestAt, latestAt]
 * and, when preferred windows are given, inside one of them (same weekday,
 * wall-clock in `timeZone`).
 */
export function entryAdmitsSlot(entry: WaitlistCandidate, slot: SlotRange, timeZone: string): boolean {
  const start = slot.startsAt.getTime();
  const durationMs = entry.durationMinutes * 60_000;
  if (durationMs <= 0) return false;
  const end = start + durationMs;
  if (end > slot.endsAt.getTime()) return false;
  if (start < entry.earliestAt.getTime()) return false;
  if (entry.latestAt && end > entry.latestAt.getTime()) return false;
  if (entry.preferredWindows.length === 0) return true;

  const p = zonedParts(slot.startsAt, timeZone);
  const startMin = p.hour * 60 + p.minute + p.second / 60;
  const endMin = startMin + entry.durationMinutes;
  return entry.preferredWindows.some(
    (w) => w.weekday === p.weekday && hhmmToMinutes(w.startTime) <= startMin && endMin <= hhmmToMinutes(w.endTime),
  );
}

/** Builds the offer queue (min-heap on `compareEntries`). O(n). */
export function entryHeap<T extends WaitlistCandidate>(entries: Iterable<T>): BinaryHeap<T> {
  return BinaryHeap.from(entries, compareEntries);
}

/** Entries in offer order (priority, then wait time), drained from a BinaryHeap. */
export function rankEntries<T extends WaitlistCandidate>(entries: Iterable<T>): T[] {
  return [...entryHeap(entries).drain()];
}

/** The entry that should be offered `slot` first, or undefined when nobody admits it. */
export function pickBestEntry<T extends WaitlistCandidate>(entries: Iterable<T>, slot: SlotRange, timeZone: string): T | undefined {
  const heap = new BinaryHeap<T>(compareEntries);
  for (const e of entries) if (entryAdmitsSlot(e, slot, timeZone)) heap.push(e);
  return heap.pop();
}

/**
 * Earliest placement of the entry inside a freed interval, stepping on a grid of
 * `stepMinutes` from the interval start (so preferred windows narrower than the
 * freed interval still get a chance). Returns the appointment range or undefined.
 */
export function firstAdmittedSlot(entry: WaitlistCandidate, freed: SlotRange, timeZone: string, stepMinutes: number): SlotRange | undefined {
  const durationMs = entry.durationMinutes * 60_000;
  const candidates = enumerateSlots([{ start: freed.startsAt.getTime(), end: freed.endsAt.getTime() }], durationMs, Math.max(1, stepMinutes) * 60_000);
  for (const c of candidates) {
    const slot = { startsAt: new Date(c.start), endsAt: new Date(c.end) };
    if (entryAdmitsSlot(entry, slot, timeZone)) return slot;
  }
  return undefined;
}
