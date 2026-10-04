import {
  enumerateSlots,
  fragmentationCost,
  freeIntervals,
  intersect,
  intersectMany,
  normalize,
  overlapsSorted,
  subtract,
  totalLength,
  unionMany,
  type Interval,
} from './intervals.js';

const I = (start: number, end: number): Interval => ({ start, end });

/** Brute-force oracle: membership of integer points, for property tests. */
function covers(set: readonly Interval[], t: number): boolean {
  return set.some((i) => i.start <= t && t < i.end);
}
function rnd(n: number): number {
  return Math.floor(Math.random() * n);
}
function randomSet(count: number, span = 100): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i < count; i++) {
    const a = rnd(span);
    out.push(I(a, a + rnd(15)));
  }
  return out;
}

describe('normalize', () => {
  it('merges overlapping and touching intervals, drops empty ones', () => {
    expect(normalize([I(5, 7), I(1, 3), I(3, 5), I(10, 10), I(12, 11)])).toEqual([I(1, 7)]);
  });
  it('is idempotent', () => {
    const s = randomSet(30);
    expect(normalize(normalize(s))).toEqual(normalize(s));
  });
});

describe('subtract', () => {
  it('punches holes', () => {
    expect(subtract([I(0, 100)], [I(10, 20), I(30, 40)])).toEqual([I(0, 10), I(20, 30), I(40, 100)]);
  });
  it('handles holes covering edges and everything', () => {
    expect(subtract([I(10, 20)], [I(0, 15)])).toEqual([I(15, 20)]);
    expect(subtract([I(10, 20)], [I(15, 30)])).toEqual([I(10, 15)]);
    expect(subtract([I(10, 20)], [I(0, 30)])).toEqual([]);
    expect(subtract([I(10, 20)], [])).toEqual([I(10, 20)]);
  });
  it('matches a point-wise oracle (property)', () => {
    for (let round = 0; round < 200; round++) {
      const a = randomSet(8);
      const b = randomSet(8);
      const r = subtract(a, b);
      for (let t = 0; t < 120; t++) expect(covers(r, t)).toBe(covers(a, t) && !covers(b, t));
    }
  });
});

describe('intersect / intersectMany', () => {
  it('intersects two sets', () => {
    expect(intersect([I(0, 10), I(20, 30)], [I(5, 25)])).toEqual([I(5, 10), I(20, 25)]);
  });
  it('treats touching intervals as non-overlapping', () => {
    expect(intersect([I(0, 10)], [I(10, 20)])).toEqual([]);
    expect(intersectMany([[I(0, 10)], [I(10, 20)], [I(0, 20)]])).toEqual([]);
  });
  it('k-way intersection equals iterated pairwise intersection (property)', () => {
    for (let round = 0; round < 100; round++) {
      const k = 2 + rnd(4);
      const sets = Array.from({ length: k }, () => randomSet(6));
      const expected = sets.slice(1).reduce((acc, s) => intersect(acc, s), normalize(sets[0]));
      expect(intersectMany(sets)).toEqual(expected);
    }
  });
  it('k-way intersection matches a point-wise oracle (property)', () => {
    for (let round = 0; round < 100; round++) {
      const sets = Array.from({ length: 3 }, () => randomSet(6));
      const r = intersectMany(sets);
      for (let t = 0; t < 120; t++) expect(covers(r, t)).toBe(sets.every((s) => covers(s, t)));
    }
  });
  it('unionMany covers the union of inputs', () => {
    const sets = [[I(0, 5)], [I(3, 8)], [I(20, 22)]];
    expect(unionMany(sets)).toEqual([I(0, 8), I(20, 22)]);
  });
});

describe('freeIntervals / enumerateSlots', () => {
  it('computes free gaps that fit a minimum length', () => {
    const avail = [I(0, 100)];
    const busy = [I(10, 20), I(25, 30), I(50, 90)];
    expect(freeIntervals(avail, busy, 10)).toEqual([I(0, 10), I(30, 50), I(90, 100)]);
    expect(freeIntervals(avail, busy, 11)).toEqual([I(30, 50)]);
  });
  it('enumerates slots on a step grid with a limit', () => {
    expect(enumerateSlots([I(0, 35), I(100, 110)], 10, 10)).toEqual([I(0, 10), I(10, 20), I(20, 30), I(100, 110)]);
    expect(enumerateSlots([I(0, 100)], 30, 15, 2)).toEqual([I(0, 30), I(15, 45)]);
  });
  it('fragmentation cost rewards best-fit placement', () => {
    const gap = I(0, 60);
    expect(fragmentationCost(gap, I(0, 30), 30)).toBe(0); // leaves a usable 30
    expect(fragmentationCost(gap, I(10, 40), 30)).toBe(30); // leaves 10 and 20, both useless
    expect(fragmentationCost(gap, I(30, 60), 30)).toBe(0);
    expect(fragmentationCost(I(0, 30), I(0, 30), 30)).toBe(0); // perfect fit
  });
  it('overlapsSorted agrees with a linear scan', () => {
    for (let round = 0; round < 100; round++) {
      const s = normalize(randomSet(10));
      const probe = I(rnd(100), rnd(100) + 1);
      if (probe.end <= probe.start) continue;
      expect(overlapsSorted(s, probe)).toBe(s.some((i) => i.start < probe.end && probe.start < i.end));
    }
  });
  it('totalLength sums normalised length', () => {
    expect(totalLength(normalize([I(0, 10), I(5, 15), I(20, 25)]))).toBe(20);
  });
});
