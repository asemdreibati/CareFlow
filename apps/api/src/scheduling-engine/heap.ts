/**
 * Binary min-heap with O(log n) push/pop and O(1) peek. Used as the priority
 * queue behind the waitlist (priority, then wait time) and slot ranking.
 * The comparator returns < 0 when `a` should come out before `b`.
 */
export class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  static from<T>(items: Iterable<T>, compare: (a: T, b: T) => number): BinaryHeap<T> {
    const h = new BinaryHeap<T>(compare);
    for (const i of items) h.items.push(i);
    // Bottom-up heapify: O(n).
    for (let i = (h.items.length >> 1) - 1; i >= 0; i--) h.siftDown(i);
    return h;
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Drain in priority order. */
  *drain(): IterableIterator<T> {
    while (!this.isEmpty()) yield this.pop() as T;
  }

  /** Snapshot in priority order without mutating the heap. */
  toSortedArray(): T[] {
    return [...this.items].sort(this.compare);
  }

  private siftUp(i: number): void {
    const items = this.items;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const items = this.items;
    const n = items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.compare(items[l], items[m]) < 0) m = l;
      if (r < n && this.compare(items[r], items[m]) < 0) m = r;
      if (m === i) break;
      [items[i], items[m]] = [items[m], items[i]];
      i = m;
    }
  }
}

/** Keep only the best `k` items of a stream in O(n log k) (bounded max-heap on the comparator). */
export function topK<T>(items: Iterable<T>, k: number, compare: (a: T, b: T) => number): T[] {
  if (k <= 0) return [];
  // Heap ordered so the WORST of the kept items is on top.
  const heap = new BinaryHeap<T>((a, b) => compare(b, a));
  for (const item of items) {
    if (heap.size < k) heap.push(item);
    else if (compare(item, heap.peek() as T) < 0) {
      heap.pop();
      heap.push(item);
    }
  }
  return heap.toSortedArray().sort(compare);
}
