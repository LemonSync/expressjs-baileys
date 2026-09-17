import type { Request, Response, NextFunction } from 'express';

export interface QueueConfig {
    maxConcurrent: number;
    maxQueueSize: number;
    timeoutMs: number;
}

interface QueueEntry {
    req: Request;
    res: Response;
    next: NextFunction;
    enqueuedAt: number;
    timer: ReturnType<typeof setTimeout>;
}

/** Concurrency-limiting request queue. When capacity is full, new requests wait or get 503. */
export function createRequestQueue(config: QueueConfig) {
    let active = 0;
    const queue: QueueEntry[] = [];

    function processNext(): void {
        if (queue.length === 0 || active >= config.maxConcurrent) return;
        const entry = queue.shift()!;
        clearTimeout(entry.timer);
        active++;
        const originalEnd = entry.res.end.bind(entry.res);
        entry.res.end = function (...args: any[]) {
            active--;
            processNext();
            return originalEnd(...args);
        } as typeof entry.res.end;
        entry.next();
    }

    function enqueue(req: Request, res: Response, next: NextFunction): void {
        if (active < config.maxConcurrent) {
            active++;
            const originalEnd = res.end.bind(res);
            res.end = function (...args: any[]) {
                active--;
                processNext();
                return originalEnd(...args);
            } as typeof res.end;
            next();
            return;
        }

        if (queue.length >= config.maxQueueSize) {
            res.setHeader('Retry-After', '5');
            res.status(503).json({ error: 'server is at capacity, try again later' });
            return;
        }

        const timer = setTimeout(() => {
            const idx = queue.indexOf(entry);
            if (idx !== -1) {
                queue.splice(idx, 1);
                res.status(504).json({ error: 'request timed out waiting in queue' });
            }
        }, config.timeoutMs);

        const entry: QueueEntry = { req, res, next, enqueuedAt: Date.now(), timer };
        queue.push(entry);

        res.setHeader('X-Queue-Position', queue.length);
        res.setHeader('X-Queue-Active', active);
    }

    function getStats() {
        return { active, queued: queue.length };
    }

    return { enqueue, getStats };
}
