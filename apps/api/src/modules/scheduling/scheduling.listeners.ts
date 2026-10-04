import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { APPOINTMENT_EVENTS, type AppointmentEvent } from '../appointments/appointments.service.js';
import { NoShowService } from './no-show.service.js';
import { RemindersService } from './reminders.service.js';
import { errorMessage } from './scheduling.common.js';

/**
 * Keeps the reminders outbox and the no-show risk in step with appointment
 * events. Handlers run inside the emitting request's async context and never
 * throw back into it.
 */
@Injectable()
export class SchedulingListeners {
  private readonly logger = new Logger(SchedulingListeners.name);

  constructor(
    private readonly reminders: RemindersService,
    private readonly noShow: NoShowService,
  ) {}

  @OnEvent(APPOINTMENT_EVENTS.created)
  onCreated(e: AppointmentEvent) {
    return Promise.all([this.guard('reminders.sync', () => this.reminders.syncForAppointment(e)), this.guard('no-show.score', () => this.noShow.score(e))]);
  }

  @OnEvent(APPOINTMENT_EVENTS.updated)
  onUpdated(e: AppointmentEvent) {
    return Promise.all([this.guard('reminders.sync', () => this.reminders.syncForAppointment(e)), this.guard('no-show.score', () => this.noShow.score(e))]);
  }

  @OnEvent(APPOINTMENT_EVENTS.cancelled)
  onCancelled(e: AppointmentEvent) {
    return this.guard('reminders.cancel', () => this.reminders.cancelForAppointment(e));
  }

  private async guard(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Scheduling listener failed for ${label}: ${errorMessage(err)}`);
    }
  }
}
