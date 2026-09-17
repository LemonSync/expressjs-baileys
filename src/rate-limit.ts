import type { Request, Response, NextFunction } from 'express';

export interface RateLimitConfig {
    ipWindowMs: number;
    ipMax: number;
    globalWindowMs: number;
    globalMax: number;
    operationalWindowMs: number;
    operationalMax: number;
    keyGenerator?: (req: Request) => string;
}

interface SlidingWindow {
    timestamps: number[];
}

function cleanup(window: SlidingWindow, now: number, windowMs: number): void {
    while (window.timestamps.length > 0 && window.timestamps[0] <= now - windowMs) {
        window.timestamps.shift();
    }
}

export function createRateLimiter(config: RateLimitConfig) {
    const ipBuckets = new Map<string, SlidingWindow>();
    const globalBucket: SlidingWindow = { timestamps: [] };
    const operationalGlobalBucket: SlidingWindow = { timestamps: [] };
    const operationalIpBuckets = new Map<string, SlidingWindow>();

    const getIp = (req: Request): string => {
        if (config.keyGenerator) return config.keyGenerator(req);
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
        return req.ip ?? req.socket.remoteAddress ?? 'unknown';
    };

    const getBucket = (map: Map<string, SlidingWindow>, key: string): SlidingWindow => {
        let bucket = map.get(key);
        if (!bucket) {
            bucket = { timestamps: [] };
            map.set(key, bucket);
        }
        return bucket;
    };

    /** Sliding-window rate limiter: per-IP + global for normal endpoints */
    function normalLimiter(req: Request, res: Response, next: NextFunction): void {
        const now = Date.now();
        const ip = getIp(req);

        const ipBucket = getBucket(ipBuckets, ip);
        cleanup(ipBucket, now, config.ipWindowMs);
        if (ipBucket.timestamps.length >= config.ipMax) {
            const retryAfter = Math.ceil((ipBucket.timestamps[0] + config.ipWindowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit-IP', config.ipMax);
            res.setHeader('X-RateLimit-Remaining-IP', 0);
            res.setHeader('X-RateLimit-Reset-IP', Math.ceil((ipBucket.timestamps[0] + config.ipWindowMs) / 1000));
            res.status(429).json({ error: 'too many requests from this IP, try again later' });
            return;
        }

        cleanup(globalBucket, now, config.globalWindowMs);
        if (globalBucket.timestamps.length >= config.globalMax) {
            const retryAfter = Math.ceil((globalBucket.timestamps[0] + config.globalWindowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit-Global', config.globalMax);
            res.setHeader('X-RateLimit-Remaining-Global', 0);
            res.setHeader('X-RateLimit-Reset-Global', Math.ceil((globalBucket.timestamps[0] + config.globalWindowMs) / 1000));
            res.status(429).json({ error: 'global rate limit exceeded, try again later' });
            return;
        }

        ipBucket.timestamps.push(now);
        globalBucket.timestamps.push(now);

        res.setHeader('X-RateLimit-Limit-IP', config.ipMax);
        res.setHeader('X-RateLimit-Remaining-IP', Math.max(0, config.ipMax - ipBucket.timestamps.length));
        res.setHeader('X-RateLimit-Limit-Global', config.globalMax);
        res.setHeader('X-RateLimit-Remaining-Global', Math.max(0, config.globalMax - globalBucket.timestamps.length));
        next();
    }

    /** Stricter rate limiter for operational endpoints (restart, logout) */
    function operationalLimiter(req: Request, res: Response, next: NextFunction): void {
        const now = Date.now();
        const ip = getIp(req);

        const ipBucket = getBucket(operationalIpBuckets, ip);
        cleanup(ipBucket, now, config.operationalWindowMs);
        if (ipBucket.timestamps.length >= config.operationalMax) {
            const retryAfter = Math.ceil((ipBucket.timestamps[0] + config.operationalWindowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit-IP', config.operationalMax);
            res.setHeader('X-RateLimit-Remaining-IP', 0);
            res.status(429).json({ error: 'too many operational requests, try again later' });
            return;
        }

        cleanup(operationalGlobalBucket, now, config.operationalWindowMs);
        if (operationalGlobalBucket.timestamps.length >= config.operationalMax) {
            const retryAfter = Math.ceil((operationalGlobalBucket.timestamps[0] + config.operationalWindowMs - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            res.setHeader('X-RateLimit-Limit-Global', config.operationalMax);
            res.setHeader('X-RateLimit-Remaining-Global', 0);
            res.status(429).json({ error: 'global operational rate limit exceeded' });
            return;
        }

        ipBucket.timestamps.push(now);
        operationalGlobalBucket.timestamps.push(now);

        res.setHeader('X-RateLimit-Limit-IP', config.operationalMax);
        res.setHeader('X-RateLimit-Remaining-IP', Math.max(0, config.operationalMax - ipBucket.timestamps.length));
        next();
    }

    /** Periodic cleanup to prevent memory leak from stale IP buckets */
    const gcInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of ipBuckets) {
            cleanup(bucket, now, config.ipWindowMs);
            if (bucket.timestamps.length === 0) ipBuckets.delete(key);
        }
        for (const [key, bucket] of operationalIpBuckets) {
            cleanup(bucket, now, config.operationalWindowMs);
            if (bucket.timestamps.length === 0) operationalIpBuckets.delete(key);
        }
        cleanup(globalBucket, now, config.globalWindowMs);
        cleanup(operationalGlobalBucket, now, config.operationalWindowMs);
    }, 60_000);

    if (gcInterval.unref) gcInterval.unref();

    return { normalLimiter, operationalLimiter };
}
