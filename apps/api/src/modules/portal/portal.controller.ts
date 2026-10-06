import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Audit, Public } from '../../common/auth/decorators.js';
import { CurrentPatient, PortalRoute, type PortalPatient } from './portal-auth.guard.js';
import { PortalAuthService } from './portal-auth.service.js';
import {
  PortalAppointmentsQuery,
  PortalBookDto,
  PortalCancelDto,
  PortalConsentDto,
  PortalSlotsQuery,
  PortalWaitlistDto,
  RequestOtpDto,
  UpdatePortalProfileDto,
  VerifyOtpDto,
} from './portal.dto.js';
import { PortalService } from './portal.service.js';

/** Phone-OTP login (public, throttled per IP). */
@ApiTags('portal')
@Controller('portal/auth')
export class PortalAuthController {
  constructor(private readonly auth: PortalAuthService) {}

  @Public()
  @Post('request-otp')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit({ action: 'portal.requestOtp' })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto);
  }

  @Public()
  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Audit({ action: 'portal.verifyOtp' })
  verify(@Body() dto: VerifyOtpDto) {
    return this.auth.verify(dto);
  }
}

/** Patient self-service; every route requires a portal token (`type: 'patient'`). */
@ApiTags('portal')
@ApiBearerAuth()
@PortalRoute()
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  me(@CurrentPatient() p: PortalPatient) {
    return this.portal.me(p);
  }

  @Patch('me')
  @Audit({ action: 'portal.updateProfile', entity: 'Patient' })
  updateMe(@CurrentPatient() p: PortalPatient, @Body() dto: UpdatePortalProfileDto) {
    return this.portal.updateMe(p, dto);
  }

  @Get('clinic')
  clinic(@CurrentPatient() p: PortalPatient) {
    return this.portal.clinic(p);
  }

  @Get('appointments')
  appointments(@CurrentPatient() p: PortalPatient, @Query() q: PortalAppointmentsQuery) {
    return this.portal.appointments(p, q);
  }

  @Get('appointments/:id')
  appointment(@CurrentPatient() p: PortalPatient, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.appointment(p, id);
  }

  @Get('slots')
  slots(@CurrentPatient() p: PortalPatient, @Query() q: PortalSlotsQuery) {
    return this.portal.slots(p, q);
  }

  /** 201 on creation; 200 + `Idempotent-Replay: true` when the `Idempotency-Key` was already used. */
  @Post('appointments')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @Audit({ action: 'portal.book', entity: 'Appointment' })
  async book(@CurrentPatient() p: PortalPatient, @Body() dto: PortalBookDto, @Headers('idempotency-key') idempotencyKey: string | undefined, @Res() res: Response) {
    const { appointment, replayed } = await this.portal.book(p, dto, idempotencyKey);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(replayed ? 200 : 201).json(appointment);
    return appointment;
  }

  @Post('appointments/:id/confirm')
  @HttpCode(200)
  @Audit({ action: 'portal.confirm', entity: 'Appointment' })
  confirm(@CurrentPatient() p: PortalPatient, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.confirm(p, id);
  }

  @Post('appointments/:id/cancel')
  @HttpCode(200)
  @Audit({ action: 'portal.cancel', entity: 'Appointment' })
  cancel(@CurrentPatient() p: PortalPatient, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PortalCancelDto) {
    return this.portal.cancel(p, id, dto);
  }

  @Get('invoices')
  invoices(@CurrentPatient() p: PortalPatient) {
    return this.portal.invoices(p);
  }

  @Get('invoices/:id')
  invoice(@CurrentPatient() p: PortalPatient, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.invoice(p, id);
  }

  @Get('waitlist')
  waitlist(@CurrentPatient() p: PortalPatient) {
    return this.portal.waitlistEntries(p);
  }

  @Post('waitlist')
  @Audit({ action: 'portal.joinWaitlist', entity: 'WaitlistEntry' })
  joinWaitlist(@CurrentPatient() p: PortalPatient, @Body() dto: PortalWaitlistDto) {
    return this.portal.joinWaitlist(p, dto);
  }

  @Post('waitlist/:id/accept')
  @HttpCode(200)
  @Audit({ action: 'portal.acceptOffer', entity: 'WaitlistEntry' })
  acceptOffer(@CurrentPatient() p: PortalPatient, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.acceptOffer(p, id);
  }

  @Post('waitlist/:id/decline')
  @HttpCode(200)
  @Audit({ action: 'portal.declineOffer', entity: 'WaitlistEntry' })
  declineOffer(@CurrentPatient() p: PortalPatient, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.declineOffer(p, id);
  }

  @Get('consents')
  consents(@CurrentPatient() p: PortalPatient) {
    return this.portal.consents(p);
  }

  @Post('consents')
  @Audit({ action: 'portal.acceptConsent', entity: 'PatientConsent' })
  acceptConsent(@CurrentPatient() p: PortalPatient, @Body() dto: PortalConsentDto) {
    return this.portal.acceptConsent(p, dto);
  }
}
