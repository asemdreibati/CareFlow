import { Role } from '@prisma/client';
import { ALL_PERMISSIONS, Permission, ROLE_PERMISSIONS, resolvePermissions } from './permissions.js';

describe('permissions', () => {
  it('owner has every permission', () => {
    expect(new Set(ROLE_PERMISSIONS.OWNER)).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('admin cannot author or sign medical records', () => {
    const admin = resolvePermissions('ADMIN');
    expect(admin.has(Permission.RecordsWrite)).toBe(false);
    expect(admin.has(Permission.RecordsSign)).toBe(false);
    expect(admin.has(Permission.MembersManage)).toBe(true);
  });

  it('doctor can sign records but is scoped to own schedule by default', () => {
    const doctor = resolvePermissions('DOCTOR');
    expect(doctor.has(Permission.RecordsSign)).toBe(true);
    expect(doctor.has(Permission.AppointmentsReadAll)).toBe(false);
    expect(doctor.has(Permission.BillingWrite)).toBe(false);
  });

  it('receptionist and accountant never touch medical records', () => {
    for (const role of ['RECEPTIONIST', 'ACCOUNTANT'] as Role[]) {
      const p = resolvePermissions(role);
      expect(p.has(Permission.RecordsRead)).toBe(false);
      expect(p.has(Permission.RecordsWrite)).toBe(false);
      expect(p.has(Permission.AiUse)).toBe(false);
    }
  });

  it('nurse can write but not sign records', () => {
    const nurse = resolvePermissions('NURSE');
    expect(nurse.has(Permission.RecordsWrite)).toBe(true);
    expect(nurse.has(Permission.RecordsSign)).toBe(false);
  });

  it('extra permissions are additive', () => {
    const doctor = resolvePermissions('DOCTOR', [Permission.AppointmentsReadAll]);
    expect(doctor.has(Permission.AppointmentsReadAll)).toBe(true);
  });

  it('every role only references known permissions', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) expect(known.has(p)).toBe(true);
    }
  });
});
