import { Module } from '@nestjs/common';
import { EmailSender } from './email.sender.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsGateway } from './notifications.gateway.js';
import { NotificationsListeners } from './notifications.listeners.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Domain events → persisted notifications → Socket.IO push.
 * `NotificationsService.notify()` is the single entry point for other modules.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway, NotificationsListeners, EmailSender],
  exports: [NotificationsService, EmailSender],
})
export class NotificationsModule {}
