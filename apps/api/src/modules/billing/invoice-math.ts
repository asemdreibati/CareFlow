/**
 * Pure invoice arithmetic. No Nest, no Prisma: everything here works on plain
 * numbers so it can be unit-tested in isolation. Money is handled as integer
 * cents internally to avoid floating-point drift, and returned as numbers with
 * two decimals.
 */

export type InvoiceStatusValue = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';

export interface LineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  serviceId?: string | null;
}

export interface LineResult extends LineInput {
  total: number;
}

export interface InvoiceTotals {
  items: LineResult[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

/**
 * Largest amount accepted anywhere on an invoice (unit price, line, discount,
 * tax, subtotal, total, payment). Well inside the DECIMAL(12,2) columns, so an
 * oversized request is a 400 instead of a numeric-overflow 500.
 */
export const MAX_MONEY = 99_999_999.99;

/** Raised for inputs that do not make an invoice (negative amounts, discount above subtotal, ...). */
export class InvoiceMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceMathError';
  }
}

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new InvoiceMathError('Amount must be a finite number');
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** Accepts a number, a numeric string or a Decimal-like object (Prisma.Decimal) and returns a plain number. */
export function toMoney(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value !== null && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) throw new InvoiceMathError(`Not a monetary value: ${String(value)}`);
  return n;
}

export function lineTotal(quantity: number, unitPrice: number): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new InvoiceMathError('quantity must be a positive integer');
  if (unitPrice < 0) throw new InvoiceMathError('unitPrice cannot be negative');
  const cents = quantity * toCents(unitPrice);
  if (cents > toCents(MAX_MONEY)) throw new InvoiceMathError(`line total cannot exceed ${MAX_MONEY.toFixed(2)}`);
  return fromCents(cents);
}

/**
 * subtotal = Σ quantity × unitPrice; total = subtotal − discount + tax.
 * The discount may not exceed the subtotal, so the total is never negative.
 */
export function computeTotals(items: LineInput[], discount = 0, tax = 0): InvoiceTotals {
  if (items.length === 0) throw new InvoiceMathError('An invoice needs at least one item');
  if (discount < 0) throw new InvoiceMathError('discount cannot be negative');
  if (tax < 0) throw new InvoiceMathError('tax cannot be negative');

  const lines: LineResult[] = items.map((item) => ({ ...item, total: lineTotal(item.quantity, item.unitPrice) }));
  const subtotalCents = lines.reduce((sum, l) => sum + toCents(l.total), 0);
  const discountCents = toCents(discount);
  const taxCents = toCents(tax);
  if (discountCents > subtotalCents) throw new InvoiceMathError('discount cannot exceed the subtotal');
  const maxCents = toCents(MAX_MONEY);
  if (subtotalCents > maxCents) throw new InvoiceMathError(`subtotal cannot exceed ${MAX_MONEY.toFixed(2)}`);
  if (taxCents > maxCents || subtotalCents - discountCents + taxCents > maxCents) throw new InvoiceMathError(`total cannot exceed ${MAX_MONEY.toFixed(2)}`);

  return {
    items: lines,
    subtotal: fromCents(subtotalCents),
    discount: fromCents(discountCents),
    tax: fromCents(taxCents),
    total: fromCents(subtotalCents - discountCents + taxCents),
  };
}

export function remainingBalance(total: number, amountPaid: number): number {
  return fromCents(Math.max(0, toCents(total) - toCents(amountPaid)));
}

/**
 * Applies a payment to an invoice. Throws when the amount is not positive or
 * exceeds the remaining balance.
 */
export function applyPayment(total: number, amountPaid: number, amount: number): { amountPaid: number; balance: number; status: 'PARTIALLY_PAID' | 'PAID' } {
  const amountCents = toCents(amount);
  if (amountCents <= 0) throw new InvoiceMathError('amount must be greater than zero');
  const balanceCents = toCents(total) - toCents(amountPaid);
  if (amountCents > balanceCents) {
    throw new InvoiceMathError(`amount exceeds the remaining balance of ${fromCents(balanceCents).toFixed(2)}`);
  }
  const newPaidCents = toCents(amountPaid) + amountCents;
  const newBalanceCents = balanceCents - amountCents;
  return { amountPaid: fromCents(newPaidCents), balance: fromCents(newBalanceCents), status: newBalanceCents === 0 ? 'PAID' : 'PARTIALLY_PAID' };
}

/** `INV-<year>-<000001>`: sequential per clinic per calendar year. */
export function invoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(6, '0')}`;
}

export function invoiceNumberPrefix(year: number): string {
  return `INV-${year}-`;
}

/** Calendar year of `at` in `timeZone` (IANA). Falls back to UTC for an unknown zone. */
export function yearInTimeZone(at: Date, timeZone: string | null | undefined): number {
  try {
    const year = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric' }).formatToParts(at).find((p) => p.type === 'year')?.value;
    const n = Number(year);
    if (Number.isInteger(n)) return n;
  } catch {
    // RangeError: invalid time zone
  }
  return at.getUTCFullYear();
}
