import { BinaryHeap, topK } from './heap.js';

describe('BinaryHeap', () => {
  it('pops in priority order', () => {
    const h = new BinaryHeap<number>((a, b) => a - b);
    for (const n of [5, 3, 9, 1, 7, 3]) h.push(n);
    expect([...h.drain()]).toEqual([1, 3, 3, 5, 7, 9]);
  });
  it('heapifies from an iterable and matches a sort (property)', () => {
    for (let round = 0; round < 50; round++) {
      const arr = Array.from({ length: 1 + Math.floor(Math.random() * 50) }, () => Math.floor(Math.random() * 1000));
      const h = BinaryHeap.from(arr, (a, b) => a - b);
      expect(h.size).toBe(arr.length);
      expect([...h.drain()]).toEqual([...arr].sort((a, b) => a - b));
    }
  });
  it('supports composite priorities (waitlist semantics: urgency, then longest wait)', () => {
    type Entry = { priority: number; createdAt: number; id: string };
    const cmp = (a: Entry, b: Entry) => b.priority - a.priority || a.createdAt - b.createdAt;
    const h = new BinaryHeap<Entry>(cmp);
    h.push({ priority: 1, createdAt: 5, id: 'routine-old' });
    h.push({ priority: 3, createdAt: 9, id: 'urgent-new' });
    h.push({ priority: 3, createdAt: 2, id: 'urgent-old' });
    h.push({ priority: 2, createdAt: 1, id: 'soon' });
    expect([...h.drain()].map((e) => e.id)).toEqual(['urgent-old', 'urgent-new', 'soon', 'routine-old']);
  });
  it('topK returns the best k in order', () => {
    const items = [9, 1, 8, 2, 7, 3, 6, 4, 5];
    expect(topK(items, 3, (a, b) => a - b)).toEqual([1, 2, 3]);
    expect(topK(items, 100, (a, b) => b - a)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(topK(items, 0, (a, b) => a - b)).toEqual([]);
  });
});
