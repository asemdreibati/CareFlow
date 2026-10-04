import { Role } from '@prisma/client';

/**
 * Fine-grained permissions. Roles map to a default set; a membership can be
 * granted extra permissions individually (ClinicMembership.extraPermissions).
 */
export const Permission = {
  ClinicRead: 'clinic:read',
  ClinicUpdate: 'clinic:update',
  MembersRead: 'members:read',
  MembersManage: 'members:manage',
  DoctorsRead: 'doctors:read',
  DoctorsWrite: 'doctors:write',
  PatientsRead: 'patients:read',
  PatientsWrite: 'patients:write',
  /** View decrypted identifiers such as the national ID. */
  PatientsSensitive: 'patients:sensitive',
  AppointmentsRead: 'appointments:read',
  AppointmentsWrite: 'appointments:write',
  /** Doctors normally only see their own schedule; this lifts that restriction. */
  AppointmentsReadAll: 'appointments:read_all',
  RecordsRead: 'records:read',
  RecordsWrite: 'records:write',
  RecordsSign: 'records:sign',
  BillingRead: 'billing:read',
  BillingWrite: 'billing:write',
  NotificationsRead: 'notifications:read',
  AuditRead: 'audit:read',
  AiUse: 'ai:use',
  AiReview: 'ai:review',
  /** Rooms/equipment catalogue. */
  ResourcesWrite: 'resources:write',
  /** Waitlist, recurring series, reschedule proposals, no-show model, reminders. */
  SchedulingManage: 'scheduling:manage',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly PermissionKey[] = Object.values(Permission);

const clinicalCore: PermissionKey[] = [
  Permission.ClinicRead,
  Permission.DoctorsRead,
  Permission.PatientsRead,
  Permission.PatientsWrite,
  Permission.AppointmentsRead,
  Permission.AppointmentsWrite,
  Permission.NotificationsRead,
];

export const ROLE_PERMISSIONS: Record<Role, readonly PermissionKey[]> = {
  OWNER: ALL_PERMISSIONS,
  // Administrators run the clinic but are not clinicians: no authoring of medical records.
  ADMIN: ALL_PERMISSIONS.filter(
    (p) => ![Permission.RecordsWrite, Permission.RecordsSign, Permission.AiUse].includes(p as never),
  ),
  DOCTOR: [
    ...clinicalCore,
    Permission.PatientsSensitive,
    Permission.RecordsRead,
    Permission.RecordsWrite,
    Permission.RecordsSign,
    Permission.BillingRead,
    Permission.AiUse,
    Permission.AiReview,
  ],
  NURSE: [...clinicalCore, Permission.AppointmentsReadAll, Permission.RecordsRead, Permission.RecordsWrite, Permission.SchedulingManage],
  RECEPTIONIST: [
    ...clinicalCore,
    Permission.AppointmentsReadAll,
    Permission.PatientsSensitive,
    Permission.BillingRead,
    Permission.BillingWrite,
    Permission.SchedulingManage,
  ],
  ACCOUNTANT: [
    Permission.ClinicRead,
    Permission.PatientsRead,
    Permission.AppointmentsRead,
    Permission.AppointmentsReadAll,
    Permission.BillingRead,
    Permission.BillingWrite,
    Permission.NotificationsRead,
  ],
};

export function resolvePermissions(role: Role, extra: readonly string[] = []): Set<string> {
  return new Set<string>([...ROLE_PERMISSIONS[role], ...extra]);
}
