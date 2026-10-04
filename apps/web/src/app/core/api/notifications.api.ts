import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import { Notification, NotificationsResponse } from '../models';

@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly http = inject(HttpClient);
  list(unreadOnly = false) {
    return this.http.get<NotificationsResponse>(`${BASE}/notifications`, { params: params({ unreadOnly: unreadOnly || undefined }) });
  }
  markRead(id: string) { return this.http.post<Notification>(`${BASE}/notifications/${id}/read`, {}); }
  readAll() { return this.http.post<void>(`${BASE}/notifications/read-all`, {}); }
}
