import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AppointmentWriterService } from './appointment-writer.service.js';
import { WaitlistController } from './waitlist.controller.js';
import { WaitlistListeners } from './waitlist.listeners.js';
import { WaitlistService } from './waitlist.service.js';

/**
 * Waitlist entries, automatic backfill of cancelled slots (timed holds) and the
 * hold-expiry job. Also exports `AppointmentWriterService`, the shared helper
 * for modules that insert/cancel appointments directly (series).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [WaitlistController],
  providers: [WaitlistService, WaitlistListeners, AppointmentWriterService],
  exports: [WaitlistService, AppointmentWriterService],
})
export class WaitlistModule {}
