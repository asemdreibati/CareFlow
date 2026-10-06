import { AiFeature } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SoapNoteDto {
  /** Clinician dictation / visit transcript. Only this text is sent to the model. */
  @IsString() @MinLength(20) @MaxLength(20_000) transcript: string;
}

export const REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export class ReviewInteractionDto {
  @IsIn(REVIEW_DECISIONS) decision: ReviewDecision;
  /** SOAP notes only: copy the approved fields into the (still DRAFT) encounter. */
  @IsOptional() @IsBoolean() applyToEncounter?: boolean;
}

export class ListInteractionsQuery {
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsEnum(AiFeature) feature?: AiFeature;
}

export class AskRecordDto {
  /** The clinician's question about this patient's record. Only the question and de-identified excerpts reach the model. */
  @IsString() @MinLength(3) @MaxLength(2000) question: string;
}
