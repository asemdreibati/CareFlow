/**
 * Smart slot search (docs/SCHEDULING.md §1): pure ranking of bookable slots across
 * one or more doctors. No Nest/Prisma here - the appointments module expands the
 * doctors' weekly availability into concrete `AvailabilityWindow`s (clinic timezone)
 * and feeds busy time (appointments, time off, the patient's own bookings) plus the
 * free intervals of any required resources.
 *
 * Pipeline per doctor and per availability window:
 *   freeIntervals(window, busy) → ∩ intersectMany(resource free) → enumerateSlots on the
 *   doctor's slot grid → scoreSlot → topK(limit).
 */
import { topK } from './heap.js';
import { enumerateSlots, fragmentationCost, freeIntervals, intersect, intersectMany, normalize, type Interval } from './intervals.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DEFAULT_SEARCH_SLOT_MINUTES = 30;

/**
 * One concrete working block of a doctor on one calendar day, already converted to
 * epoch ms. `wallStartMinutes` is the wall-clock time (minutes since midnight in the
 * clinic timezone) at `start`, used to evaluate preferred windows without a timezone
 * library inside the engine.
 */
export interface AvailabilityWindow extends Interval {
  /** Calendar day key in the clinic timezone ("YYYY-MM-DD"). */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  wallStartMinutes: number;
}

export interface DoctorCandidate {
  id: string;
  /** Availability blocks expanded over the search range. */
  blocks: readonly AvailabilityWindow[];
  /** Slot grid (minutes) per weekday; missing weekdays use DEFAULT_SEARCH_SLOT_MINUTES. */
  slotMinutesByWeekday: Readonly<Partial<Record<number, number>>>;
  /** Active appointments ∪ time off ∪ (optionally) the patient's own appointments. */
  busy: readonly Interval[];
  /** Minutes already booked per day key - drives the load-balancing term. */
  bookedMinutesByDay: Readonly<Record<string, number>>;
}

/** Wall-clock window the patient prefers ("HH:mm" in the clinic timezone). */
export interface PreferredWindow {
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface SlotSearchInput {
  /** Earliest acceptable slot start (epoch ms). Soonness is measured from here. */
  from: number;
  /** Latest acceptable slot end (epoch ms). Defaults to unbounded. */
  to?: number;
  durationMinutes: number;
  doctors: readonly DoctorCandidate[];
  preferredDoctorId?: string;
  preferredWindows?: readonly PreferredWindow[];
  /** Free intervals of each required resource; a slot must lie inside their common intersection. */
  resourceFree?: readonly (readonly Interval[])[];
  /** Max candidates returned (default 10). */
  limit?: number;
}

export interface ScoreBreakdown {
  soonness: number;
  preferredDoctor: number;
  inPreferredWindow: number;
  loadBalance: number;
  fragmentation: number;
}

export interface SlotCandidate extends Interval {
  doctorId: string;
  /** Lower is better. */
  score: number;
  breakdown: ScoreBreakdown;
  reasons: string[];
}

/** Weights from the contract; the score is expressed in "hours of waiting". */
export const SCORE_WEIGHTS = {
  soonnessPerHour: 1,
  preferredDoctorBonus: -6,
  preferredWindowBonus: -3,
  /** +1 per 30 minutes already booked on that day. */
  loadBalancePerBookedMinute: 1 / 30,
  /** +1 per 10 minutes of unusable leftover gap. */
  fragmentationPerMinute: 1 / 10,
} as const;

export interface ScoreInput {
  slot: Interval;
  /** The doctor's free gap that contains the slot (before resource intersection). */
  gap: Interval;
  from: number;
  isPreferredDoctor: boolean;
  inPreferredWindow: boolean;
  bookedMinutesThatDay: number;
  /** Leftover gaps shorter than this are considered unusable (the doctor's slot length). */
  minUsefulMinutes: number;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Scoring function of the contract. Deterministic and side-effect free. */
export function scoreSlot(input: ScoreInput): { score: number; breakdown: ScoreBreakdown; reasons: string[] } {
  const hoursFromStart = Math.max(0, input.slot.start - input.from) / HOUR_MS;
  const fragmentMinutes = fragmentationCost(input.gap, input.slot, input.minUsefulMinutes * MINUTE_MS) / MINUTE_MS;
  const breakdown: ScoreBreakdown = {
    soonness: hoursFromStart * SCORE_WEIGHTS.soonnessPerHour,
    preferredDoctor: input.isPreferredDoctor ? SCORE_WEIGHTS.preferredDoctorBonus : 0,
    inPreferredWindow: input.inPreferredWindow ? SCORE_WEIGHTS.preferredWindowBonus : 0,
    loadBalance: input.bookedMinutesThatDay * SCORE_WEIGHTS.loadBalancePerBookedMinute,
    fragmentation: fragmentMinutes * SCORE_WEIGHTS.fragmentationPerMinute,
  };
  const score = breakdown.soonness + breakdown.preferredDoctor + breakdown.inPreferredWindow + breakdown.loadBalance + breakdown.fragmentation;

  const reasons: string[] = [];
  reasons.push(hoursFromStart < 1 ? 'Earliest possible start' : `Starts ${round(hoursFromStart, 1)}h after the requested start`);
  if (input.isPreferredDoctor) reasons.push('Preferred doctor');
  if (input.inPreferredWindow) reasons.push('Within a preferred time window');
  reasons.push(input.bookedMinutesThatDay === 0 ? 'Doctor has a free day' : `Doctor already has ${input.bookedMinutesThatDay} min booked that day`);
  reasons.push(fragmentMinutes === 0 ? 'Fits without leaving an unusable gap' : `Leaves ${fragmentMinutes} min of unusable gap`);

  return { score: round(score, 4), breakdown, reasons };
}

/** Total order: score, then start time, then doctor id → deterministic results. */
export function compareCandidates(a: SlotCandidate, b: SlotCandidate): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.start !== b.start) return a.start - b.start;
  if (a.doctorId === b.doctorId) return 0;
  return a.doctorId < b.doctorId ? -1 : 1;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Smallest grid point `origin + k·step` that is >= t. */
function alignUp(t: number, origin: number, step: number): number {
  if (t <= origin) return origin;
  return origin + Math.ceil((t - origin) / step) * step;
}

function isInPreferredWindow(windows: readonly PreferredWindow[], weekday: number, wallStart: number, durationMinutes: number): boolean {
  return windows.some(
    (w) => w.weekday === weekday && hhmmToMinutes(w.startTime) <= wallStart && wallStart + durationMinutes <= hhmmToMinutes(w.endTime),
  );
}

/** Lazily enumerate every scored slot of one doctor. */
function* doctorCandidates(doctor: DoctorCandidate, input: SlotSearchInput, resourceCommon: Interval[] | undefined): Generator<SlotCandidate> {
  const durationMs = input.durationMinutes * MINUTE_MS;
  const to = input.to ?? Number.MAX_SAFE_INTEGER;
  const busy = normalize(doctor.busy);
  const preferred = input.preferredWindows ?? [];
  const isPreferredDoctor = input.preferredDoctorId !== undefined && input.preferredDoctorId === doctor.id;

  for (const block of doctor.blocks) {
    const window: Interval = { start: block.start, end: Math.min(block.end, to) };
    if (window.end - window.start < durationMs) continue;
    const slotMinutes = doctor.slotMinutesByWeekday[block.weekday] ?? DEFAULT_SEARCH_SLOT_MINUTES;
    const stepMs = Math.max(1, slotMinutes) * MINUTE_MS;
    const bookedMinutesThatDay = doctor.bookedMinutesByDay[block.date] ?? 0;

    // Fragmentation is judged against the doctor's own free gap, so keep it before
    // the resource intersection and the `from` clip.
    for (const gap of freeIntervals([window], busy, durationMs)) {
      const regions = resourceCommon ? intersect([gap], resourceCommon) : [gap];
      for (const region of regions) {
        const start = alignUp(Math.max(region.start, input.from), block.start, stepMs);
        if (start + durationMs > region.end) continue;
        for (const slot of enumerateSlots([{ start, end: region.end }], durationMs, stepMs)) {
          const wallStart = block.wallStartMinutes + (slot.start - block.start) / MINUTE_MS;
          const scored = scoreSlot({
            slot,
            gap,
            from: input.from,
            isPreferredDoctor,
            inPreferredWindow: isInPreferredWindow(preferred, block.weekday, wallStart, input.durationMinutes),
            bookedMinutesThatDay,
            minUsefulMinutes: slotMinutes,
          });
          yield { doctorId: doctor.id, start: slot.start, end: slot.end, ...scored };
        }
      }
    }
  }
}

function* allCandidates(input: SlotSearchInput, resourceCommon: Interval[] | undefined): Generator<SlotCandidate> {
  for (const doctor of input.doctors) yield* doctorCandidates(doctor, input, resourceCommon);
}

/**
 * Ranked slot candidates (best first, at most `limit`). Memory is bounded by `limit`
 * thanks to `topK`; enumeration is lazy.
 */
export function searchSlots(input: SlotSearchInput): SlotCandidate[] {
  if (input.durationMinutes <= 0 || !Number.isFinite(input.durationMinutes)) return [];
  const limit = input.limit ?? 10;
  // Required resources: a slot must be free for ALL of them.
  const resourceCommon = input.resourceFree && input.resourceFree.length > 0 ? intersectMany(input.resourceFree) : undefined;
  return topK(allCandidates(input, resourceCommon), limit, compareCandidates);
}
