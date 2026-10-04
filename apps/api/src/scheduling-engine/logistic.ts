/**
 * Logistic regression trained by full-batch gradient descent with L2
 * regularisation on standardised features. Small, dependency-free and
 * deterministic: it is used for the per-clinic no-show predictor.
 */

export interface LogisticSample {
  features: readonly number[];
  /** 1 = positive class (e.g. no-show), 0 = negative. */
  label: 0 | 1;
}

export interface LogisticMetrics {
  accuracy: number;
  auc: number;
  positiveRate: number;
  n: number;
}

export interface LogisticModel {
  bias: number;
  /** One weight per (standardised) feature. */
  weights: number[];
  /** Per-feature mean used for standardisation. */
  means: number[];
  /** Per-feature standard deviation (1 when the feature is constant). */
  scales: number[];
  metrics: LogisticMetrics;
}

export interface TrainOptions {
  epochs?: number;
  /** Learning rate. */
  lr?: number;
  /** L2 penalty on the weights (not the bias). */
  l2?: number;
}

export interface Standardisation {
  means: number[];
  scales: number[];
}

/** Column-wise mean and population standard deviation; constant columns get scale 1. */
export function standardisation(rows: readonly (readonly number[])[], dims: number): Standardisation {
  const means = Array.from({ length: dims }, (): number => 0);
  const scales = Array.from({ length: dims }, (): number => 1);
  const n = rows.length;
  if (n === 0) return { means, scales };
  for (const r of rows) for (let k = 0; k < dims; k++) means[k] += r[k] ?? 0;
  for (let k = 0; k < dims; k++) means[k] /= n;
  for (const r of rows) {
    for (let k = 0; k < dims; k++) {
      const d = (r[k] ?? 0) - means[k];
      scales[k] += d * d;
    }
  }
  for (let k = 0; k < dims; k++) {
    const variance = (scales[k] - 1) / n; // undo the initial 1
    scales[k] = variance > 1e-12 ? Math.sqrt(variance) : 1;
  }
  return { means, scales };
}

export function standardise(features: readonly number[], s: Standardisation): number[] {
  const out = Array.from({ length: s.means.length }, (): number => 0);
  for (let k = 0; k < s.means.length; k++) out[k] = ((features[k] ?? 0) - s.means[k]) / s.scales[k];
  return out;
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function logit(bias: number, weights: readonly number[], x: readonly number[]): number {
  let z = bias;
  for (let k = 0; k < weights.length; k++) z += weights[k] * (x[k] ?? 0);
  return z;
}

/**
 * Trains the model. Features are standardised with the training-set statistics
 * (stored on the model so `predictLogistic` can apply the same transform). The
 * gradient is the mean log-loss gradient plus `l2 * w` on the weights.
 */
export function trainLogistic(samples: readonly LogisticSample[], opts: TrainOptions = {}): LogisticModel {
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  const n = samples.length;
  const dims = n === 0 ? 0 : Math.max(0, ...samples.map((s) => s.features.length));
  const stats = standardisation(
    samples.map((s) => s.features),
    dims,
  );
  const X = samples.map((s) => standardise(s.features, stats));
  const y = samples.map((s) => s.label);

  const weights = Array.from({ length: dims }, (): number => 0);
  let bias = 0;
  if (n > 0) {
    const grad = Array.from({ length: dims }, (): number => 0);
    for (let epoch = 0; epoch < epochs; epoch++) {
      grad.fill(0);
      let gradBias = 0;
      for (let i = 0; i < n; i++) {
        const err = sigmoid(logit(bias, weights, X[i])) - y[i];
        gradBias += err;
        const x = X[i];
        for (let k = 0; k < dims; k++) grad[k] += err * x[k];
      }
      bias -= (lr * gradBias) / n;
      for (let k = 0; k < dims; k++) weights[k] -= lr * (grad[k] / n + l2 * weights[k]);
    }
  }

  const scores = X.map((x) => sigmoid(logit(bias, weights, x)));
  let correct = 0;
  let positives = 0;
  for (let i = 0; i < n; i++) {
    if ((scores[i] >= 0.5 ? 1 : 0) === y[i]) correct++;
    positives += y[i];
  }
  return {
    bias,
    weights,
    means: stats.means,
    scales: stats.scales,
    metrics: {
      accuracy: n === 0 ? 0 : correct / n,
      auc: auc(scores, y),
      positiveRate: n === 0 ? 0 : positives / n,
      n,
    },
  };
}

/** Probability of the positive class for raw (unstandardised) features. */
export function predictLogistic(model: Pick<LogisticModel, 'bias' | 'weights' | 'means' | 'scales'>, features: readonly number[]): number {
  const x = standardise(features, { means: model.means, scales: model.scales });
  return sigmoid(logit(model.bias, model.weights, x));
}

/**
 * Area under the ROC curve via the rank-sum (Mann–Whitney U) formulation with
 * average ranks for ties, O(n log n). Returns 0.5 when one class is missing.
 */
export function auc(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const n = scores.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const ranks = Array.from({ length: n }, (): number => 0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank of the tie group
    for (let k = i; k <= j; k++) ranks[order[k]] = avg;
    i = j + 1;
  }
  let positives = 0;
  let rankSum = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k] === 1) {
      positives++;
      rankSum += ranks[k];
    }
  }
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}
