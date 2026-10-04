import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { tenantContext } from './tenant-context.js';

/** Creates the per-request context and tags the response with a request id. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    tenantContext.run(
      {
        requestId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      },
      () => next(),
    );
  }
}
