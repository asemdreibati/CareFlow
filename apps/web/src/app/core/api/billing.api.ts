import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import { BillingSummary, CreateInvoiceDto, Invoice, InvoiceStatus, Paginated, PaymentDto, Service, ServiceDto } from '../models';

@Injectable({ providedIn: 'root' })
export class BillingApi {
  private readonly http = inject(HttpClient);
  services() { return this.http.get<Service[]>(`${BASE}/billing/services`); }
  createService(dto: ServiceDto) { return this.http.post<Service>(`${BASE}/billing/services`, dto); }
  updateService(id: string, dto: Partial<ServiceDto>) { return this.http.patch<Service>(`${BASE}/billing/services/${id}`, dto); }
  invoices(q: { status?: InvoiceStatus | ''; patientId?: string; page?: number; pageSize?: number }) {
    return this.http.get<Paginated<Invoice>>(`${BASE}/billing/invoices`, { params: params(q) });
  }
  invoice(id: string) { return this.http.get<Invoice>(`${BASE}/billing/invoices/${id}`); }
  createInvoice(dto: CreateInvoiceDto) { return this.http.post<Invoice>(`${BASE}/billing/invoices`, dto); }
  updateInvoice(id: string, dto: Partial<CreateInvoiceDto>) { return this.http.patch<Invoice>(`${BASE}/billing/invoices/${id}`, dto); }
  issue(id: string) { return this.http.post<Invoice>(`${BASE}/billing/invoices/${id}/issue`, {}); }
  void(id: string) { return this.http.post<Invoice>(`${BASE}/billing/invoices/${id}/void`, {}); }
  pay(id: string, dto: PaymentDto) { return this.http.post<Invoice>(`${BASE}/billing/invoices/${id}/payments`, dto); }
  summary(q?: { from?: string; to?: string }) { return this.http.get<BillingSummary>(`${BASE}/billing/summary`, { params: params(q) }); }
}
