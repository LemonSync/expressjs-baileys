import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
    apiKeys: string[];
    operationalKeys: string[];
}

function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Validate X-API-Key header against allowed keys. Stricter key set for operational endpoints. */
export function createAuthMiddleware(config: AuthConfig) {
    function normalAuth(req: Request, res: Response, next: NextFunction): void {
        if (config.apiKeys.length === 0) return next();
        const key = req.headers['x-api-key'];
        if (typeof key !== 'string' || !config.apiKeys.some((k) => safeCompare(k, key))) {
            res.status(401).json({ error: 'unauthorized: invalid or missing X-API-Key header' });
            return;
        }
        next();
    }

    function operationalAuth(req: Request, res: Response, next: NextFunction): void {
        if (config.operationalKeys.length === 0) return normalAuth(req, res, next);
        const key = req.headers['x-api-key'];
        if (typeof key !== 'string' || !config.operationalKeys.some((k) => safeCompare(k, key))) {
            res.status(401).json({ error: 'unauthorized: invalid or missing X-API-Key header for operational endpoint' });
            return;
        }
        next();
    }

    return { normalAuth, operationalAuth };
}
