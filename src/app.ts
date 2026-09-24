import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { errorHandler, notFound } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import type { AuthService } from './services/authService';

export interface AppDeps {
  auth: AuthService;
  cookieSecure: boolean;
  /** Optional readiness probe, e.g. a `SELECT 1` against auth-db. */
  healthCheck?: () => Promise<void>;
}

export function createApp({ auth, cookieSecure, healthCheck }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  app.get('/healthz', async (_req, res) => {
    try {
      await healthCheck?.();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/api/auth', authRouter(auth, { cookieSecure }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
