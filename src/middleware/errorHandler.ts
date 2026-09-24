import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors';

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body is invalid',
        details: err.issues.map((issue) => ({
          field: issue.path.join('.') || null,
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  // body-parser errors (malformed JSON, payload too large) carry a status.
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request body' } });
    return;
  }

  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
