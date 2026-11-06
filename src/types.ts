/**
 * Caps of a limiter.
 */
export interface LimiterOptions {
    /**
     * Length of the window in milliseconds, a positive integer.
     */
    window: number;
    /**
     * Requests one key may make over any window, a positive integer.
     */
    client: number;
    /**
     * Requests all the keys together may make over a fixed window, a positive integer; none when omitted.
     */
    global?: number;
}

/**
 * Answer of a check that lets the request through.
 */
export interface Allowed {
    ok: true;
    /**
     * Cap of the key that applied, the per-call limit or the one of the options.
     */
    limit: number;
    /**
     * Requests the key may still make before it is refused, this one counted.
     */
    remaining: number;
    /**
     * Seconds until the oldest request of the key leaves the window, at least 1 and at most the window rounded up
     * to whole seconds.
     */
    reset: number;
}

/**
 * Answer of a check that refuses the request, which counts nowhere.
 */
export interface Refused {
    ok: false;
    /**
     * Cap that was reached: the global one is looked at first.
     */
    scope: 'client' | 'global';
    /**
     * Value of that cap.
     */
    limit: number;
    /**
     * Seconds to wait before the request can pass, at least 1 and at most the window rounded up to whole seconds.
     */
    retryAfter: number;
}

export type Decision = Allowed | Refused;

/**
 * Limiter whose counters belong to it alone.
 */
export interface Limiter {
    /**
     * Decides one request and, when it passes, counts it.
     *
     * @param key - Who makes the request, any string, `__proto__` included
     * @param now - Current time in milliseconds, a finite number from a clock that does not go back
     * @param limit - Cap of this key for this call, a positive integer, in place of the one of the options
     * @returns The decision, with the figures a response header needs
     * @throws RangeError when now is not a finite number or limit is not an integer of 1 or more
     */
    check(key: string, now: number, limit?: number): Decision;
}
