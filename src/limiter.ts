import type { Decision, Limiter, LimiterOptions } from './types.js';

export type { Allowed, Decision, Limiter, LimiterOptions, Refused } from './types.js';

/**
 * Checks that a cap is a positive integer.
 *
 * @param value - Cap to check
 * @param name - Name of the cap, for the message
 * @throws RangeError when the value is not an integer of 1 or more
 */
function assertCap(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be an integer of 1 or more.`);
}

/**
 * Checks that a time is a finite number.
 *
 * @param now - Time to check, in milliseconds
 * @throws RangeError when the time is NaN or infinite, which would stop the windows from ever moving on
 */
function assertTime(now: number): void {
    if (!Number.isFinite(now)) throw new RangeError('now must be a finite number of milliseconds.');
}

/**
 * Converts a wait in milliseconds into the whole seconds a header carries.
 *
 * @param milliseconds - Wait, which is zero for a fractional clock that lands exactly on the end of a window
 * @param window - Length of the window in milliseconds, which no wait goes past
 * @returns At least 1 second and at most the window rounded up to whole seconds
 */
function seconds(milliseconds: number, window: number): number {
    return Math.min(Math.ceil(window / 1000), Math.max(1, Math.ceil(milliseconds / 1000)));
}

/**
 * Drops the keys left with no request inside the window, so that the map does not grow without bound.
 * Every check prunes the hits of its own key again, so a sweep frees memory but never changes a decision.
 *
 * @param hits - Request times per key, pruned in place
 * @param now - Current time in milliseconds
 * @param window - Length of the window in milliseconds
 */
function sweep(hits: Map<string, number[]>, now: number, window: number): void {
    for (const [key, times] of hits) {
        if (!times.some((time) => now - time < window)) hits.delete(key);
    }
}

/**
 * Creates a limiter, capped per key over a sliding window and, optionally, over all the keys over a fixed window.
 * The caller gives the clock, so the limiter reads no time, runs no timer and works on any JavaScript runtime. The
 * global cap protects the server and the per-key cap keeps one noisy client from using it all. Idle keys are swept by
 * the checks themselves, once per window. A refused request counts nowhere, so a client that keeps asking is let
 * through again as soon as its window empties; without a global cap, the keys of one window are the only thing that
 * can grow, which a cap on the keys of the caller should bound.
 *
 * @param options - Window, per-key cap and optional global cap
 * @returns A limiter whose counters belong to it alone
 * @throws RangeError when a cap or the window is not an integer of 1 or more
 */
export function createLimiter(options: LimiterOptions): Limiter {
    const { window, client, global } = options;
    assertCap(window, 'window');
    assertCap(client, 'client');
    if (global !== undefined) assertCap(global, 'global');

    const hits = new Map<string, number[]>();
    let requests = 0;
    let windowEnd: number | null = null;
    let sweepTime: number | null = null;

    return {
        check(key, now, limit = client): Decision {
            assertTime(now);
            assertCap(limit, 'limit');

            if (sweepTime === null || now >= sweepTime) {
                if (sweepTime !== null) sweep(hits, now, window);
                sweepTime = now + window;
            }
            if (windowEnd === null || now >= windowEnd) {
                requests = 0;
                windowEnd = now + window;
            }

            if (global !== undefined && requests >= global) {
                return { ok: false, scope: 'global', limit: global, retryAfter: seconds(windowEnd - now, window) };
            }

            const recent = (hits.get(key) ?? []).filter((time) => now - time < window);
            if (recent.length >= limit) {
                return {
                    ok: false,
                    scope: 'client',
                    limit,
                    retryAfter: seconds(recent[recent.length - limit] + window - now, window),
                };
            }

            recent.push(now);
            hits.set(key, recent);
            requests++;

            return {
                ok: true,
                limit,
                remaining: limit - recent.length,
                reset: seconds(recent[0] + window - now, window),
            };
        },
    };
}
