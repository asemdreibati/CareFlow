import type { Role } from '@prisma/client';

/** Claims carried in the access token. The token is bound to one active clinic. */
export interface JwtPayload {
  sub: string;
  email: string;
  clinicId: string;
  role: Role;
  /** Doctor profile id in the active clinic, when the user is a doctor. */
  doctorId?: string;
  type: 'access';
}

export interface AuthUser {
  id: string;
  email: string;
  clinicId: string;
  role: Role;
  doctorId?: string;
  permissions: ReadonlySet<string>;
}
