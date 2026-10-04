import { Body, Controller, Get, HttpCode, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { CreateInvoiceDto, CreatePaymentDto, CreateServiceDto, InvoiceListQuery, SummaryQuery, UpdateInvoiceDto, UpdateServiceDto } from './billing.dto.js';
import { BillingService } from './billing.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  // ───────────────────────────── price list ─────────────────────────────

  @Get('services')
  @RequirePermissions(Permission.BillingRead)
  listServices(@CurrentUser() user: AuthUser, @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean) {
    return this.billing.listServices(user.clinicId, includeInactive ?? false);
  }

  @Post('services')
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.createService', entity: 'Service' })
  createService(@CurrentUser() user: AuthUser, @Body() dto: CreateServiceDto) {
    return this.billing.createService(user.clinicId, dto);
  }

  @Patch('services/:id')
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.updateService', entity: 'Service' })
  updateService(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceDto) {
    return this.billing.updateService(user.clinicId, id, dto);
  }

  // ─────────────────────────────── summary ───────────────────────────────

  // Declared before `invoices/:id` so the literal segment is never read as an id.
  @Get('summary')
  @RequirePermissions(Permission.BillingRead)
  summary(@CurrentUser() user: AuthUser, @Query() q: SummaryQuery) {
    return this.billing.summary(user.clinicId, q);
  }

  // ─────────────────────────────── invoices ───────────────────────────────

  @Get('invoices')
  @RequirePermissions(Permission.BillingRead)
  listInvoices(@CurrentUser() user: AuthUser, @Query() q: InvoiceListQuery) {
    return this.billing.listInvoices(user.clinicId, q);
  }

  @Get('invoices/:id')
  @RequirePermissions(Permission.BillingRead)
  getInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.getInvoice(user.clinicId, id);
  }

  @Post('invoices')
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.createInvoice', entity: 'Invoice' })
  createInvoice(@CurrentUser() user: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.billing.createInvoice(user, dto);
  }

  @Patch('invoices/:id')
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.updateInvoice', entity: 'Invoice' })
  updateInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceDto) {
    return this.billing.updateInvoice(user.clinicId, id, dto);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.issueInvoice', entity: 'Invoice' })
  issueInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.issueInvoice(user, id);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.voidInvoice', entity: 'Invoice' })
  voidInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.voidInvoice(user.clinicId, id);
  }

  // ─────────────────────────────── payments ───────────────────────────────

  @Post('invoices/:id/payments')
  @RequirePermissions(Permission.BillingWrite)
  @Audit({ action: 'billing.addPayment', entity: 'Invoice' })
  addPayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePaymentDto) {
    return this.billing.addPayment(user, id, dto);
  }
}
