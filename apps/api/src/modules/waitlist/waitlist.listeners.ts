import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { APPOINTMENT_EVENTS, type AppointmentEvent } from '../appointments/appointments.service.js';
import { WaitlistService } from './waitlist.service.js';

/**
 * Backfill trigger: a cancelled appointment frees a slot that is offered to the
 * best waiting entry. Runs inside the emitting request's async context (RLS on)
 * and never throws (the service guards itself).
 */
@Injectable()
export class WaitlistListeners {
  constructor(private readonly waitlist: WaitlistService) {}

  @OnEvent(APPOINTMENT_EVENTS.cancelled)
  onAppointmentCancelled(e: AppointmentEvent) {
    return this.waitlist.onAppointmentCancelled(e);
  }
}
