import { MessageChannel, MessageDirection } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

export class ListMessagesQuery extends PaginationQuery {
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsUUID() appointmentId?: string;
  @IsOptional() @IsEnum(MessageChannel) channel?: MessageChannel;
  @IsOptional() @IsEnum(MessageDirection) direction?: MessageDirection;
}

export class SendMessageDto {
  @IsUUID() patientId: string;
  @IsEnum(MessageChannel) channel: MessageChannel;
  @IsString() @MinLength(1) @MaxLength(4000) body: string;
  /** Email subject (optional, email only). */
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  /** Link the message to an appointment (optional). */
  @IsOptional() @IsUUID() appointmentId?: string;
}

/** Twilio inbound webhook form fields (only the ones we read; others pass through). */
export interface TwilioInboundBody {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  SmsMessageSid?: string;
  [key: string]: unknown;
}

export interface TwilioStatusBody {
  MessageSid?: string;
  SmsSid?: string;
  MessageStatus?: string;
  SmsStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  [key: string]: unknown;
}
