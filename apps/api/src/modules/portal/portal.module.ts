import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { WaitlistModule } from '../waitlist/waitlist.module.js';
import { PortalAuthGuard } from './portal-auth.guard.js';
import { PortalAuthService } from './portal-auth.service.js';
import { PortalAuthController, PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';

/**
 * Patient portal (`/portal/...`): phone-OTP login and patient-scoped
 * self-service (profile, appointments, slots, invoices, waitlist, consents).
 * `JwtService` comes from the global CommonModule.
 */
@Module({
  imports: [MessagingModule, WaitlistModule, AppointmentsModule],
  controllers: [PortalAuthController, PortalController],
  providers: [PortalAuthGuard, PortalAuthService, PortalService],
})
export class PortalModule {}
