import type { NextFunction, Request, Response } from 'express';

type Handler = (req: Request, res: Response) => Promise<void>;

export const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};
