import { Component, computed, inject, input } from '@angular/core';
import { LanguageService } from '../core/i18n/language.service';

const COLORS: Record<string, string> = {
  // appointments
  SCHEDULED: 'blue', CONFIRMED: 'teal', CHECKED_IN: 'purple', IN_PROGRESS: 'amber', COMPLETED: 'green', CANCELLED: 'red', NO_SHOW: 'gray',
  // invoices
  DRAFT: 'gray', ISSUED: 'blue', PARTIALLY_PAID: 'amber', PAID: 'green', VOID: 'red',
  // encounters / prescriptions / AI
  SIGNED: 'green', AMENDED: 'amber', ACTIVE: 'green', DISCONTINUED: 'red', GENERATED: 'blue', APPROVED: 'green', REJECTED: 'red', FAILED: 'red',
  // roles
  OWNER: 'purple', ADMIN: 'blue', DOCTOR: 'teal', NURSE: 'green', RECEPTIONIST: 'amber', ACCOUNTANT: 'gray',
  // allergy severity
  MILD: 'gray', MODERATE: 'amber', SEVERE: 'red', LIFE_THREATENING: 'red',
  TRUE: 'green', FALSE: 'gray',
  // waitlist
  WAITING: 'blue', OFFERED: 'amber', BOOKED: 'green', EXPIRED: 'gray',
  URGENT: 'red', SOON: 'amber', ROUTINE: 'gray',
  // reschedule proposals / reminders / series
  PENDING: 'blue', APPLIED: 'green', PARTIALLY_APPLIED: 'amber', DISMISSED: 'gray', SENT: 'green',
  // resources
  ROOM: 'teal', EQUIPMENT: 'purple', STAFF: 'blue', OTHER: 'gray',
  // reminder channels
  IN_APP: 'blue', EMAIL: 'purple', SMS: 'teal',
};

@Component({
  selector: 'cf-chip',
  template: `<span class="chip" [class]="'chip ' + color()"><span class="dot"></span>{{ label() }}</span>`,
})
export class StatusChipComponent {
  private readonly lang = inject(LanguageService);
  readonly status = input.required<string | boolean | null | undefined>();
  readonly text = input<string>();
  /** Enum group for the label lookup (`enums.<group>.<VALUE>`); all groups are searched when omitted. */
  readonly group = input<string>();
  readonly color = computed(() => COLORS[String(this.status()).toUpperCase()] ?? 'gray');
  readonly label = computed(() => {
    if (this.text()) return this.text();
    const s = this.status();
    if (typeof s === 'boolean') return this.lang.enumLabel(s ? 'ACTIVE' : 'INACTIVE', 'status');
    return this.lang.enumLabel(s, this.group());
  });
}
