import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InvoiceStatus, Prisma } from '@prisma/client';
import type { Invoice, InvoiceItem, Payment, Service } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { CreateInvoiceDto, CreatePaymentDto, CreateServiceDto, InvoiceItemDto, InvoiceListQuery, SummaryQuery, UpdateInvoiceDto, UpdateServiceDto } from './billing.dto.js';
import { applyPayment, computeTotals, InvoiceMathError, invoiceNumber, invoiceNumberPrefix, remainingBalance, toMoney, yearInTimeZone, type InvoiceTotals, type LineInput } from './invoice-math.js';

export const INVOICE_ISSUED = 'invoice.issued';
export const PAYMENT_RECEIVED = 'payment.received';

const DUE_IN_DAYS = 14;
/** Statuses an invoice may be voided from (and only while nothing has been paid). */
const VOIDABLE: InvoiceStatus[] = ['DRAFT', 'ISSUED'];

const patientSummary = { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } } as const;
// Items have no ordering column (ids are random UUIDs); they come back in insertion order.
const invoiceDetail = {
  patient: patientSummary,
  items: { orderBy: { position: 'asc' as const } },
  payments: { orderBy: { paidAt: 'asc' } },
} satisfies Prisma.InvoiceInclude;

type PatientSummary = { id: string; mrn: string; firstName: string; lastName: string; phone: string | null };
type InvoiceRow = Invoice & { patient: PatientSummary; items?: InvoiceItem[]; payments?: Payment[] };

/** Invoice as returned by the API: Decimal columns become plain numbers and the open balance is included. */
export interface InvoiceView extends Omit<Invoice, 'subtotal' | 'discount' | 'tax' | 'total' | 'amountPaid'> {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  amountPaid: number;
  balance: number;
  patient: PatientSummary;
  items?: (Omit<InvoiceItem, 'unitPrice' | 'total'> & { unitPrice: number; total: number })[];
  payments?: (Omit<Payment, 'amount'> & { amount: number })[];
}

export interface BillingEvent {
  invoice: InvoiceView;
  actorUserId: string;
}

export function toInvoiceView(row: InvoiceRow): InvoiceView {
  const { subtotal, discount, tax, total, amountPaid, items, payments, ...rest } = row;
  const totalN = toMoney(total);
  const paidN = toMoney(amountPaid);
  return {
    ...rest,
    subtotal: toMoney(subtotal),
    discount: toMoney(discount),
    tax: toMoney(tax),
    total: totalN,
    amountPaid: paidN,
    balance: remainingBalance(totalN, paidN),
    ...(items ? { items: items.map((i) => ({ ...i, unitPrice: toMoney(i.unitPrice), total: toMoney(i.total) })) } : {}),
    ...(payments ? { payments: payments.map((p) => ({ ...p, amount: toMoney(p.amount) })) } : {}),
  };
}

function toServiceView(s: Service) {
  return { ...s, price: toMoney(s.price) };
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ───────────────────────────── price list ─────────────────────────────

  async listServices(clinicId: string, includeInactive = false) {
    const rows = await this.prisma.db.service.findMany({
      where: { clinicId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
    });
    return rows.map(toServiceView);
  }

  async createService(clinicId: string, dto: CreateServiceDto) {
    const row = await this.prisma.db.service.create({ data: { ...dto, code: dto.code.toUpperCase(), clinicId } });
    return toServiceView(row);
  }

  async updateService(clinicId: string, id: string, dto: UpdateServiceDto) {
    const exists = await this.prisma.db.service.findFirst({ where: { id, clinicId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Service not found');
    const row = await this.prisma.db.service.update({ where: { id }, data: { ...dto, code: dto.code?.toUpperCase() } });
    return toServiceView(row);
  }

  // ─────────────────────────────── invoices ───────────────────────────────

  async listInvoices(clinicId: string, q: InvoiceListQuery) {
    const where: Prisma.InvoiceWhereInput = {
      clinicId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.search
        ? { OR: [
            { number: { contains: q.search, mode: 'insensitive' } },
            { patient: { firstName: { contains: q.search, mode: 'insensitive' } } },
            { patient: { lastName: { contains: q.search, mode: 'insensitive' } } },
            { patient: { mrn: { contains: q.search, mode: 'insensitive' } } },
          ] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.invoice.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: { createdAt: 'desc' }, include: { patient: patientSummary } }),
      this.prisma.db.invoice.count({ where }),
    ]);
    return paginate(rows.map(toInvoiceView), total, q);
  }

  async getInvoice(clinicId: string, id: string): Promise<InvoiceView> {
    const row = await this.prisma.db.invoice.findFirst({ where: { id, clinicId }, include: invoiceDetail });
    if (!row) throw new NotFoundException('Invoice not found');
    return toInvoiceView(row);
  }

  async createInvoice(user: AuthUser, dto: CreateInvoiceDto): Promise<InvoiceView> {
    const clinicId = user.clinicId;
    const patient = await this.prisma.db.patient.findFirst({ where: { id: dto.patientId, clinicId }, select: { id: true } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (dto.appointmentId) {
      const appt = await this.prisma.db.appointment.findFirst({ where: { id: dto.appointmentId, clinicId }, select: { patientId: true } });
      if (!appt) throw new NotFoundException('Appointment not found');
      if (appt.patientId !== dto.patientId) throw new BadRequestException('Appointment belongs to a different patient');
    }
    if (dto.encounterId) {
      const enc = await this.prisma.db.encounter.findFirst({ where: { id: dto.encounterId, clinicId }, select: { patientId: true } });
      if (!enc) throw new NotFoundException('Encounter not found');
      if (enc.patientId !== dto.patientId) throw new BadRequestException('Encounter belongs to a different patient');
    }
    const clinic = await this.prisma.db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { currency: true, timezone: true } });
    const totals = await this.resolveTotals(clinicId, dto.items, dto.discount, dto.tax);

    const create = () =>
      this.prisma.transaction(async (tx) => {
        // Numbering year follows the clinic's calendar (an invoice at 01:00 on Jan 1st in Riyadh is next year's).
        const number = await this.nextInvoiceNumber(tx, clinicId, yearInTimeZone(new Date(), clinic.timezone));
        return tx.invoice.create({
          data: {
            clinicId,
            patientId: dto.patientId,
            appointmentId: dto.appointmentId,
            encounterId: dto.encounterId,
            number,
            currency: clinic.currency,
            subtotal: totals.subtotal,
            discount: totals.discount,
            tax: totals.tax,
            total: totals.total,
            dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
            notes: dto.notes,
            createdById: user.id,
            items: { create: totals.items.map((l, position) => ({ clinicId, serviceId: l.serviceId ?? undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total, position })) },
          },
          include: invoiceDetail,
        });
      });

    let row: InvoiceRow;
    try {
      row = await create();
    } catch (err) {
      // Numbers are allocated under an advisory lock, so this only fires if a number was inserted out of band.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') row = await create();
      else throw err;
    }
    return toInvoiceView(row);
  }

  /**
   * Drafts can be reshaped freely; once issued, an invoice is immutable (void it
   * and create a new one). The invoice row is locked (`FOR UPDATE`) and its status
   * re-checked inside the transaction, so an issue/void racing this edit either
   * waits for it or makes it fail with 409; items are never replaced on an issued invoice.
   */
  async updateInvoice(clinicId: string, id: string, dto: UpdateInvoiceDto): Promise<InvoiceView> {
    const row = await this.prisma.transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: InvoiceStatus }[]>`
        SELECT status FROM invoices WHERE id = ${id}::uuid AND clinic_id = ${clinicId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Invoice not found');
      if (locked[0].status !== 'DRAFT') throw new ConflictException('Only draft invoices can be edited');

      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { position: 'asc' } } } });
      const lines: InvoiceItemDto[] =
        dto.items ?? invoice.items.map((i) => ({ serviceId: i.serviceId ?? undefined, description: i.description, quantity: i.quantity, unitPrice: toMoney(i.unitPrice) }));
      const totals = await this.resolveTotals(clinicId, lines, dto.discount ?? toMoney(invoice.discount), dto.tax ?? toMoney(invoice.tax), tx);

      const touched = await tx.invoice.updateMany({
        where: { id, clinicId, status: 'DRAFT' },
        data: {
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
          ...(dto.dueAt !== undefined ? { dueAt: new Date(dto.dueAt) } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });
      if (touched.count !== 1) throw new ConflictException('Only draft invoices can be edited');
      if (dto.items) {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: id, clinicId } });
        await tx.invoiceItem.createMany({ data: totals.items.map((l, position) => ({ clinicId, invoiceId: id, serviceId: l.serviceId ?? undefined, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total, position })) });
      }
      return tx.invoice.findUniqueOrThrow({ where: { id }, include: invoiceDetail });
    });
    return toInvoiceView(row);
  }

  /** DRAFT → ISSUED as a compare-and-set: a second issue (or an issue racing a void) gets 409. */
  async issueInvoice(user: AuthUser, id: string): Promise<InvoiceView> {
    const clinicId = user.clinicId;
    await this.findInvoice(clinicId, id);
    const issuedAt = new Date();
    const row = await this.prisma.transaction(async (tx) => {
      const issued = await tx.invoice.updateMany({ where: { id, clinicId, status: 'DRAFT' }, data: { status: 'ISSUED', issuedAt } });
      if (issued.count !== 1) {
        const current = await tx.invoice.findFirst({ where: { id, clinicId }, select: { status: true } });
        throw new ConflictException(`Invoice is ${current?.status ?? 'gone'}; only drafts can be issued`);
      }
      await tx.invoice.updateMany({ where: { id, clinicId, dueAt: null }, data: { dueAt: new Date(issuedAt.getTime() + DUE_IN_DAYS * 86_400_000) } });
      return tx.invoice.findUniqueOrThrow({ where: { id }, include: invoiceDetail });
    });
    const view = toInvoiceView(row);
    this.events.emit(INVOICE_ISSUED, { invoice: view, actorUserId: user.id } satisfies BillingEvent);
    return view;
  }

  /**
   * Voids an unpaid DRAFT or ISSUED invoice. The status and `amountPaid = 0` are
   * part of the write, so a payment that lands first makes the void a 409 (and a
   * void that lands first makes the payment a 409).
   */
  async voidInvoice(clinicId: string, id: string): Promise<InvoiceView> {
    await this.findInvoice(clinicId, id);
    const voided = await this.prisma.db.invoice.updateMany({
      where: { id, clinicId, status: { in: VOIDABLE }, amountPaid: 0 },
      data: { status: 'VOID' },
    });
    if (voided.count !== 1) {
      const current = await this.findInvoice(clinicId, id);
      if (current.status === 'VOID') throw new ConflictException('Invoice is already void');
      throw new ConflictException(`Invoice is ${current.status}; only unpaid draft or issued invoices can be voided`);
    }
    return this.getInvoice(clinicId, id);
  }

  // ─────────────────────────────── payments ───────────────────────────────

  async addPayment(user: AuthUser, invoiceId: string, dto: CreatePaymentDto): Promise<InvoiceView> {
    const clinicId = user.clinicId;
    const row = await this.prisma.transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, clinicId } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'ISSUED' && invoice.status !== 'PARTIALLY_PAID') {
        throw new ConflictException(`Invoice is ${invoice.status}; payments are only accepted on issued invoices`);
      }
      let next: ReturnType<typeof applyPayment>;
      try {
        next = applyPayment(toMoney(invoice.total), toMoney(invoice.amountPaid), dto.amount);
      } catch (err) {
        throw err instanceof InvoiceMathError ? new BadRequestException(err.message) : err;
      }
      await tx.payment.create({
        data: {
          clinicId,
          invoiceId,
          amount: dto.amount,
          method: dto.method,
          reference: dto.reference,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : undefined,
          receivedById: user.id,
        },
      });
      // Optimistic guard: a concurrent payment that changed amountPaid in between makes this a no-op → 409.
      const updated = await tx.invoice.updateMany({
        where: { id: invoiceId, clinicId, amountPaid: invoice.amountPaid, status: invoice.status },
        data: { amountPaid: next.amountPaid, status: next.status },
      });
      if (updated.count !== 1) throw new ConflictException('Invoice changed while recording the payment; retry');
      return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: invoiceDetail });
    });
    const view = toInvoiceView(row);
    this.events.emit(PAYMENT_RECEIVED, { invoice: view, actorUserId: user.id } satisfies BillingEvent);
    return view;
  }

  // ─────────────────────────────── summary ───────────────────────────────

  /** Headline billing figures for invoices issued in the window (all time when no window is given). */
  async summary(clinicId: string, q: SummaryQuery) {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    if (from && to && to < from) throw new BadRequestException('to must be after from');
    const window: Prisma.InvoiceWhereInput = from || to ? { issuedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};

    const [sums, groups] = await Promise.all([
      this.prisma.db.invoice.aggregate({
        where: { clinicId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] }, ...window },
        _sum: { total: true, amountPaid: true },
      }),
      this.prisma.db.invoice.groupBy({ by: ['status'], where: { clinicId, ...window }, _count: { _all: true } }),
    ]);
    const invoiced = toMoney(sums._sum.total);
    const collected = toMoney(sums._sum.amountPaid);
    const byStatus = Object.fromEntries(Object.values(InvoiceStatus).map((s) => [s, 0])) as Record<InvoiceStatus, number>;
    for (const g of groups) byStatus[g.status] = g._count._all;
    return { invoiced, collected, outstanding: remainingBalance(invoiced, collected), byStatus };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async findInvoice<I extends Prisma.InvoiceInclude>(clinicId: string, id: string, include?: I) {
    const row = await this.prisma.db.invoice.findFirst({ where: { id, clinicId }, include });
    if (!row) throw new NotFoundException('Invoice not found');
    return row as Prisma.InvoiceGetPayload<{ include: I }>;
  }

  /** Turns request lines into priced lines (service lookups) and computes the totals. */
  private async resolveTotals(clinicId: string, items: InvoiceItemDto[], discount?: number, tax?: number, tx?: Prisma.TransactionClient): Promise<InvoiceTotals> {
    const serviceIds = [...new Set(items.map((i) => i.serviceId).filter((id): id is string => !!id))];
    const args = { where: { id: { in: serviceIds }, clinicId, isActive: true } } satisfies Prisma.ServiceFindManyArgs;
    const services: Service[] = serviceIds.length ? await (tx ? tx.service.findMany(args) : this.prisma.db.service.findMany(args)) : [];
    const byId = new Map(services.map((s) => [s.id, s]));

    const lines: LineInput[] = items.map((item, idx) => {
      const service = item.serviceId ? byId.get(item.serviceId) : undefined;
      if (item.serviceId && !service) throw new BadRequestException(`items[${idx}].serviceId is not an active service of this clinic`);
      const description = item.description ?? service?.name;
      const unitPrice = item.unitPrice ?? (service ? toMoney(service.price) : undefined);
      if (!description) throw new BadRequestException(`items[${idx}].description is required for free-text lines`);
      if (unitPrice === undefined) throw new BadRequestException(`items[${idx}].unitPrice is required for free-text lines`);
      return { serviceId: service?.id ?? null, description, quantity: item.quantity, unitPrice };
    });

    try {
      return computeTotals(lines, discount ?? 0, tax ?? 0);
    } catch (err) {
      throw err instanceof InvoiceMathError ? new BadRequestException(err.message) : err;
    }
  }

  /**
   * Sequential `INV-YYYY-000001` per clinic and (clinic-local) year, allocated
   * inside the caller's transaction. A transaction-scoped advisory lock per
   * clinic+year serialises concurrent creates, and the next number follows the
   * highest one in use (not the row count, which drifts if rows are removed or
   * numbered out of band).
   */
  private async nextInvoiceNumber(tx: Prisma.TransactionClient, clinicId: string, year: number): Promise<string> {
    const prefix = invoiceNumberPrefix(year);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${clinicId}:${year}`}))`;
    const rows = await tx.$queryRaw<{ seq: number | null }[]>`
      SELECT max(substring(number FROM ${prefix.length + 1}::int)::int)::int AS seq
      FROM invoices
      WHERE clinic_id = ${clinicId}::uuid
        AND number ~ ${`^${prefix}[0-9]{1,9}$`}`;
    return invoiceNumber(year, Number(rows[0]?.seq ?? 0) + 1);
  }
}
