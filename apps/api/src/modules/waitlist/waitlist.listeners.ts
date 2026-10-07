import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { APPOINTMENT_EVENTS, type AppointmentEvent } from '../appointments/appointments.service.js';
import { WaitlistService } from './waitlist.service.js';

/**
 * Backfill trigger: a cancelled appointment frees a slot that is offered to the
 * best waiting entry. Hold settlement: a held appointment confirmed / checked in
 * through any path (staff, portal, SMS reply) becomes firm. Runs inside the
 * emitting request's async context (RLS on) and never throws (the service guards
 * itself).
 */
@Injectable()
export class WaitlistListeners {
  constructor(private readonly waitlist: WaitlistService) {}

  @OnEvent(APPOINTMENT_EVENTS.cancelled)
  onAppointmentCancelled(e: AppointmentEvent) {
    return this.waitlist.onAppointmentCancelled(e);
  }

  @OnEvent(APPOINTMENT_EVENTS.updated)
  onAppointmentUpdated(e: AppointmentEvent) {
    return this.waitlist.onAppointmentProgressed(e);
  }

  @OnEvent(APPOINTMENT_EVENTS.checkedIn)
  onAppointmentCheckedIn(e: AppointmentEvent) {
    return this.waitlist.onAppointmentProgressed(e);
  }
}
