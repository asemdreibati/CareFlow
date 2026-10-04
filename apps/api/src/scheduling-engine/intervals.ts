/**
 * Interval algebra on half-open ranges [start, end) expressed in epoch milliseconds.
 *
 * All functions are pure and allocation-light. Inputs need not be sorted or
 * disjoint unless stated; outputs are always sorted and disjoint ("normalised").
 * Complexity is O(n log n) for the sort plus a single sweep.
 */

export interface Interval {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
}

export function length(i: Interval): number {
  return Math.max(0, i.end - i.start);
}

export function totalLength(list: readonly Interval[]): number {
  let sum = 0;
  for (const i of list) sum += length(i);
  return sum;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when `inner` lies completely inside `outer`. */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function byStart(a: Interval, b: Interval): number {
  return a.start - b.start || a.end - b.end;
}

/**
 * Union of possibly-overlapping intervals → sorted, disjoint, non-empty.
 * Touching intervals ([1,2) and [2,3)) are merged into one.
 */
export function normalize(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort(byStart);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** `a \ b`: parts of `a` not covered by `b`. Both inputs may be unsorted/overlapping. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const base = normalize(a);
  const holes = normalize(b);
  const out: Interval[] = [];
  let h = 0;
  for (const seg of base) {
    let cursor = seg.start;
    // Skip holes that end before this segment starts.
    while (h < holes.length && holes[h].end <= seg.start) h++;
    let k = h;
    while (k < holes.length && holes[k].start < seg.end) {
      const hole = holes[k];
      if (hole.start > cursor) out.push({ start: cursor, end: Math.min(hole.start, seg.end) });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= seg.end) break;
      k++;
    }
    if (cursor < seg.end) out.push({ start: cursor, end: seg.end });
  }
  return out;
}

/** `a ∩ b` for two interval sets (two-pointer sweep over normalised inputs). */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = normalize(a);
  const y = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i].start, y[j].start);
    const end = Math.min(x[i].end, y[j].end);
    if (start < end) out.push({ start, end });
    if (x[i].end < y[j].end) i++;
    else j++;
  }
  return out;
}

/**
 * k-way intersection: the time covered by ALL of the given sets at once.
 * Sweep-line over boundary events keeping a coverage counter; a point is in the
 * result exactly while the counter equals `sets.length`. O(N log N) in the total
 * number of intervals, independent of k.
 */
export function intersectMany(sets: readonly (readonly Interval[])[]): Interval[] {
  if (sets.length === 0) return [];
  if (sets.length === 1) return normalize(sets[0]);
  const events: { at: number; delta: number }[] = [];
  for (const set of sets) {
    for (const i of normalize(set)) {
      events.push({ at: i.start, delta: +1 });
      events.push({ at: i.end, delta: -1 });
    }
  }
  // Ends before starts at the same instant so touching intervals do not count as overlapping.
  events.sort((p, q) => p.at - q.at || p.delta - q.delta);
  const out: Interval[] = [];
  let depth = 0;
  let openedAt = 0;
  for (const e of events) {
    const before = depth;
    depth += e.delta;
    if (before < sets.length && depth === sets.length) openedAt = e.at;
    else if (before === sets.length && depth < sets.length && e.at > openedAt) out.push({ start: openedAt, end: e.at });
  }
  return out;
}

/** Union of many sets (same sweep, counter > 0). */
export function unionMany(sets: readonly (readonly Interval[])[]): Interval[] {
  const all: Interval[] = [];
  for (const s of sets) all.push(...s);
  return normalize(all);
}

/**
 * Free time = `availability` minus `busy`, keeping only gaps that can fit `minLengthMs`.
 * This is the core primitive behind every "find a slot" feature.
 */
export function freeIntervals(availability: readonly Interval[], busy: readonly Interval[], minLengthMs = 0): Interval[] {
  return subtract(availability, busy).filter((i) => length(i) >= minLengthMs);
}

/** Clip a set to a window. */
export function clip(list: readonly Interval[], window: Interval): Interval[] {
  return intersect(list, [window]);
}

/**
 * Enumerate candidate slots of `durationMs` inside each free interval, stepping by
 * `stepMs` from the interval start. Returns at most `limit` slots (earliest first).
 */
export function enumerateSlots(free: readonly Interval[], durationMs: number, stepMs: number, limit = Infinity): Interval[] {
  if (durationMs <= 0 || stepMs <= 0) return [];
  const out: Interval[] = [];
  for (const gap of normalize(free)) {
    for (let s = gap.start; s + durationMs <= gap.end; s += stepMs) {
      out.push({ start: s, end: s + durationMs });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Fragmentation score of placing `slot` inside `gap` (a free interval): the amount
 * of leftover free time that is too small to be useful (< `minUsefulMs`). Lower is
 * better; 0 means the slot leaves no useless fragments (best-fit).
 */
export function fragmentationCost(gap: Interval, slot: Interval, minUsefulMs: number): number {
  const before = slot.start - gap.start;
  const after = gap.end - slot.end;
  let cost = 0;
  if (before > 0 && before < minUsefulMs) cost += before;
  if (after > 0 && after < minUsefulMs) cost += after;
  return cost;
}

/** Binary search: index of the first interval whose end is > t (or list.length). */
export function firstEndingAfter(sorted: readonly Interval[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Does `probe` overlap any interval of a normalised, sorted set? O(log n). */
export function overlapsSorted(sorted: readonly Interval[], probe: Interval): boolean {
  const idx = firstEndingAfter(sorted, probe.start);
  return idx < sorted.length && sorted[idx].start < probe.end;
}
