import { auc, predictLogistic, sigmoid, standardisation, standardise, trainLogistic, type LogisticSample } from './logistic.js';

/** O(n²) pairwise AUC oracle: P(score+ > score−) + ½ P(tie). */
function aucBrute(scores: number[], labels: (0 | 1)[]): number {
  let pairs = 0;
  let won = 0;
  for (let i = 0; i < scores.length; i++) {
    if (labels[i] !== 1) continue;
    for (let j = 0; j < scores.length; j++) {
      if (labels[j] !== 0) continue;
      pairs++;
      if (scores[i] > scores[j]) won += 1;
      else if (scores[i] === scores[j]) won += 0.5;
    }
  }
  return pairs === 0 ? 0.5 : won / pairs;
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe('standardisation', () => {
  it('centres and scales columns, leaving constant columns at scale 1', () => {
    const rows = [
      [1, 5, 10],
      [3, 5, 20],
      [5, 5, 30],
    ];
    const s = standardisation(rows, 3);
    expect(s.means).toEqual([3, 5, 20]);
    expect(s.scales[0]).toBeCloseTo(Math.sqrt(8 / 3));
    expect(s.scales[1]).toBe(1);
    expect(standardise([3, 5, 20], s)).toEqual([0, 0, 0]);
    expect(standardise([5, 9], s)[2]).toBeCloseTo(-20 / s.scales[2]);
  });
  it('handles no rows', () => {
    expect(standardisation([], 2)).toEqual({ means: [0, 0], scales: [1, 1] });
  });
});

describe('sigmoid', () => {
  it('is numerically stable at the extremes', () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(2)).toBeCloseTo(1 / (1 + Math.exp(-2)));
  });
});

describe('auc', () => {
  it('is 1 for perfect ranking, 0 for inverted, 0.5 for a single class', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.3, 0.3, 0.3], [1, 1, 1])).toBe(0.5);
    expect(auc([], [])).toBe(0.5);
  });
  it('handles ties like the pairwise definition', () => {
    expect(auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
    expect(auc([0.7, 0.5, 0.5, 0.1], [1, 1, 0, 0])).toBeCloseTo(0.875);
  });
  it('matches the brute-force pairwise AUC on random data (200 rounds)', () => {
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(Math.random() * 40);
      // Coarse scores to produce plenty of ties.
      const scores = Array.from({ length: n }, () => Math.floor(Math.random() * 6) / 5);
      const labels = Array.from({ length: n }, () => (Math.random() < 0.4 ? 1 : 0) as 0 | 1);
      expect(auc(scores, labels)).toBeCloseTo(aucBrute(scores, labels), 10);
    }
  });
});

describe('trainLogistic', () => {
  function separable(n: number): LogisticSample[] {
    const out: LogisticSample[] = [];
    for (let i = 0; i < n; i++) {
      const label = (i % 2) as 0 | 1;
      // Positive class centred at (+2, +2, noise), negative at (−2, −2, noise); scale differs per column.
      const shift = label === 1 ? 2 : -2;
      out.push({ features: [shift + gaussian() * 0.8, 100 * (shift + gaussian() * 0.8), gaussian() * 5], label });
    }
    return out;
  }

  it('learns a separable problem with AUC > 0.9 and sensible metrics', () => {
    const samples = separable(400);
    const model = trainLogistic(samples, { epochs: 300, lr: 0.2, l2: 0.001 });
    expect(model.weights).toHaveLength(3);
    expect(model.metrics.n).toBe(400);
    expect(model.metrics.positiveRate).toBeCloseTo(0.5);
    expect(model.metrics.auc).toBeGreaterThan(0.9);
    expect(model.metrics.accuracy).toBeGreaterThan(0.85);
    expect(model.weights[0]).toBeGreaterThan(0);
    expect(model.weights[1]).toBeGreaterThan(0);
    expect(Math.abs(model.weights[2])).toBeLessThan(Math.abs(model.weights[0]));

    // Held-out points on each side of the boundary.
    expect(predictLogistic(model, [3, 300, 0])).toBeGreaterThan(0.9);
    expect(predictLogistic(model, [-3, -300, 0])).toBeLessThan(0.1);
    const p = predictLogistic(model, [0, 0, 0]);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it('shrinks weights with stronger L2 regularisation', () => {
    const samples = separable(200);
    const weak = trainLogistic(samples, { epochs: 200, lr: 0.2, l2: 0 });
    const strong = trainLogistic(samples, { epochs: 200, lr: 0.2, l2: 1 });
    const norm = (w: number[]) => Math.hypot(...w);
    expect(norm(strong.weights)).toBeLessThan(norm(weak.weights));
  });

  it('predicts the base rate for an uninformative problem and copes with empty input', () => {
    const samples: LogisticSample[] = Array.from({ length: 100 }, (_, i) => ({ features: [1, 1], label: (i < 30 ? 1 : 0) as 0 | 1 }));
    const model = trainLogistic(samples, { epochs: 500, lr: 0.5, l2: 0 });
    expect(predictLogistic(model, [1, 1])).toBeCloseTo(0.3, 1);
    expect(model.metrics.auc).toBe(0.5);

    const empty = trainLogistic([]);
    expect(empty.weights).toEqual([]);
    expect(empty.metrics).toEqual({ accuracy: 0, auc: 0.5, positiveRate: 0, n: 0 });
    expect(predictLogistic(empty, [])).toBe(0.5);
  });
});
