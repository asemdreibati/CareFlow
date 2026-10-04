import { applyPayment, computeTotals, InvoiceMathError, invoiceNumber, lineTotal, remainingBalance, toMoney } from './invoice-math.js';

describe('invoice math', () => {
  describe('lineTotal', () => {
    it('multiplies quantity by unit price without floating-point drift', () => {
      expect(lineTotal(3, 0.1)).toBe(0.3);
      expect(lineTotal(2, 150)).toBe(300);
      expect(lineTotal(1, 19.99)).toBe(19.99);
    });

    it('rejects non-positive or fractional quantities and negative prices', () => {
      expect(() => lineTotal(0, 10)).toThrow(InvoiceMathError);
      expect(() => lineTotal(1.5, 10)).toThrow(InvoiceMathError);
      expect(() => lineTotal(1, -1)).toThrow(InvoiceMathError);
    });
  });

  describe('computeTotals', () => {
    const items = [
      { description: 'Consultation', quantity: 1, unitPrice: 150 },
      { description: 'CBC', quantity: 2, unitPrice: 60.5 },
    ];

    it('computes subtotal, discount, tax and total', () => {
      const t = computeTotals(items, 21, 10.5);
      expect(t.items.map((i) => i.total)).toEqual([150, 121]);
      expect(t.subtotal).toBe(271);
      expect(t.discount).toBe(21);
      expect(t.tax).toBe(10.5);
      expect(t.total).toBe(260.5);
    });

    it('defaults discount and tax to zero', () => {
      expect(computeTotals(items).total).toBe(271);
    });

    it('never produces a negative total: discount may not exceed subtotal', () => {
      expect(() => computeTotals(items, 271.01)).toThrow(/exceed/);
      expect(computeTotals(items, 271).total).toBe(0);
    });

    it('rejects empty invoices and negative discount or tax', () => {
      expect(() => computeTotals([])).toThrow(InvoiceMathError);
      expect(() => computeTotals(items, -1)).toThrow(InvoiceMathError);
      expect(() => computeTotals(items, 0, -1)).toThrow(InvoiceMathError);
    });
  });

  describe('applyPayment', () => {
    it('moves to PARTIALLY_PAID while a balance remains', () => {
      expect(applyPayment(260.5, 0, 100)).toEqual({ amountPaid: 100, balance: 160.5, status: 'PARTIALLY_PAID' });
    });

    it('moves to PAID when the balance reaches zero', () => {
      expect(applyPayment(260.5, 100, 160.5)).toEqual({ amountPaid: 260.5, balance: 0, status: 'PAID' });
    });

    it('rejects overpayment and non-positive amounts', () => {
      expect(() => applyPayment(100, 60, 40.01)).toThrow(/exceeds/);
      expect(() => applyPayment(100, 0, 0)).toThrow(InvoiceMathError);
      expect(() => applyPayment(100, 0, -5)).toThrow(InvoiceMathError);
    });

    it('is exact for cent-level sums that are not exactly representable in binary', () => {
      // 0.1 + 0.2 !== 0.3 in floating point; cents arithmetic must still reach PAID.
      expect(applyPayment(0.3, 0.1, 0.2).status).toBe('PAID');
    });
  });

  describe('helpers', () => {
    it('remainingBalance clamps at zero', () => {
      expect(remainingBalance(100, 40)).toBe(60);
      expect(remainingBalance(100, 100)).toBe(0);
      expect(remainingBalance(100, 120)).toBe(0);
    });

    it('invoiceNumber is zero-padded per year', () => {
      expect(invoiceNumber(2026, 1)).toBe('INV-2026-000001');
      expect(invoiceNumber(2026, 123456)).toBe('INV-2026-123456');
    });

    it('toMoney accepts numbers, numeric strings and Decimal-like objects', () => {
      expect(toMoney(12.5)).toBe(12.5);
      expect(toMoney('12.50')).toBe(12.5);
      expect(toMoney({ toNumber: () => 7.25 })).toBe(7.25);
      expect(toMoney(null)).toBe(0);
      expect(() => toMoney('abc')).toThrow(InvoiceMathError);
    });
  });
});
