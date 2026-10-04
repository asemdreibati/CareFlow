import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE } from './http-utils';
import { InviteMemberDto, Member, PermissionsCatalog, UpdateMemberDto } from '../models';

@Injectable({ providedIn: 'root' })
export class MembersApi {
  private readonly http = inject(HttpClient);
  list() { return this.http.get<Member[]>(`${BASE}/members`); }
  permissions() { return this.http.get<PermissionsCatalog>(`${BASE}/members/permissions`); }
  invite(dto: InviteMemberDto) { return this.http.post<Member>(`${BASE}/members`, dto); }
  update(id: string, dto: UpdateMemberDto) { return this.http.patch<Member>(`${BASE}/members/${id}`, dto); }
}
