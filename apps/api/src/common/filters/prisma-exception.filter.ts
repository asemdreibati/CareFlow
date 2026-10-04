import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Translates database errors into meaningful HTTP responses:
 *  - unique violations and the appointment overlap exclusion → 409 Conflict
 *  - missing rows → 404
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const http =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? this.translate(exception)
        : this.translateUnknown(exception);
    if (http.getStatus() >= 500) this.logger.error(exception.message, exception.stack);
    res.status(http.getStatus()).json(http.getResponse());
  }

  /** Exclusion-constraint violations arrive without a Prisma error code. */
  private translateUnknown(e: Prisma.PrismaClientUnknownRequestError): HttpException {
    if (e.message.includes('appointments_no_overlap')) {
      return new ConflictException('This time slot overlaps another appointment for the doctor');
    }
    if (e.message.includes('is append-only')) {
      return new ConflictException('This record is append-only and cannot be modified');
    }
    return new HttpException({ statusCode: 500, message: 'Database error' }, 500);
  }

  private translate(e: Prisma.PrismaClientKnownRequestError): HttpException {
    const meta = e.meta as { target?: string[]; constraint?: string; driverAdapterError?: unknown } | undefined;
    switch (e.code) {
      case 'P2002':
        return new ConflictException(`Duplicate value for ${(meta?.target ?? ['unique field']).join(', ')}`);
      case 'P2025':
        return new NotFoundException('Record not found');
      case 'P2003':
        return new ConflictException('Operation violates a reference to another record');
      case 'P2004': {
        // Raw constraint violation (e.g. exclusion constraint on appointments).
        if (e.message.includes('appointments_no_overlap')) {
          return new ConflictException('This time slot overlaps another appointment for the doctor');
        }
        return new ConflictException('Database constraint violated');
      }
      default:
        if (e.message.includes('appointments_no_overlap')) {
          return new ConflictException('This time slot overlaps another appointment for the doctor');
        }
        return new HttpException({ statusCode: 500, message: 'Database error', code: e.code }, 500);
    }
  }
}
