import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { createLimiter } from '../dist/limiter.js';

const WINDOW = 10_000;

/**
 * Makes a limiter over the window of the tests.
 *
 * @param client - Per-key cap
 * @param global - Global cap, none when omitted
 * @returns The limiter
 */
const make = (client, global) => createLimiter({ window: WINDOW, client, global });

describe('options', () => {
    test('refuse a window or a cap that is not an integer of 1 or more', () => {
        for (const bad of [0, -1, 1.5, NaN, Infinity, '10']) {
            assert.throws(() => createLimiter({ window: bad, client: 1 }), RangeError, `window ${bad}`);
            assert.throws(() => createLimiter({ window: 1, client: bad }), RangeError, `client ${bad}`);
            assert.throws(() => createLimiter({ window: 1, client: 1, global: bad }), RangeError, `global ${bad}`);
            assert.throws(() => make(1).check('a', 0, bad), RangeError, `limit ${bad}`);
        }
    });

    test('name the option in the message', () => {
        assert.throws(() => createLimiter({ window: 0, client: 1 }), /window must be/);
        assert.throws(() => createLimiter({ window: 1, client: 0 }), /client must be/);
        assert.throws(() => createLimiter({ window: 1, client: 1, global: 0 }), /global must be/);
        assert.throws(() => make(1).check('a', 0, 0), /limit must be/);
    });

    test('refuse a time that is not finite', () => {
        const limiter = make(1, 1);

        for (const bad of [NaN, Infinity, -Infinity, undefined]) {
            assert.throws(() => limiter.check('a', bad), /now must be/, String(bad));
        }
        assert.equal(limiter.check('a', 0).ok, true);
        assert.equal(limiter.check('b', WINDOW).ok, true);
    });

    test('accept no global cap', () => {
        const limiter = make(1000);
        for (let index = 0; index < 5000; index++) assert.equal(limiter.check(`key${index}`, 0).ok, true);
    });
});

describe('per-key cap', () => {
    test('let the key through up to its cap, then refuse', () => {
        const limiter = make(3);

        assert.deepEqual(limiter.check('a', 0), { ok: true, limit: 3, remaining: 2, reset: 10 });
        assert.deepEqual(limiter.check('a', 0), { ok: true, limit: 3, remaining: 1, reset: 10 });
        assert.deepEqual(limiter.check('a', 0), { ok: true, limit: 3, remaining: 0, reset: 10 });
        assert.deepEqual(limiter.check('a', 0), { ok: false, scope: 'client', limit: 3, retryAfter: 10 });
    });

    test('count each key on its own', () => {
        const limiter = make(1);

        assert.equal(limiter.check('a', 0).ok, true);
        assert.equal(limiter.check('b', 0).ok, true);
        assert.equal(limiter.check('a', 0).ok, false);
        assert.equal(limiter.check('b', 0).ok, false);
    });

    test('free one slot at a time as the oldest requests leave the window', () => {
        const limiter = make(3);
        for (const time of [0, 2000, 4000]) assert.equal(limiter.check('a', time).ok, true);

        assert.deepEqual(limiter.check('a', 5000), { ok: false, scope: 'client', limit: 3, retryAfter: 5 });
        assert.deepEqual(limiter.check('a', 9999), { ok: false, scope: 'client', limit: 3, retryAfter: 1 });
        assert.deepEqual(limiter.check('a', 10_000), { ok: true, limit: 3, remaining: 0, reset: 2 });
        assert.deepEqual(limiter.check('a', 10_001), { ok: false, scope: 'client', limit: 3, retryAfter: 2 });
        assert.equal(limiter.check('a', 12_000).ok, true);
    });

    test('keep a request in the window until it is a whole window old', () => {
        const limiter = make(1);
        limiter.check('a', 0);

        assert.equal(limiter.check('a', WINDOW - 1).ok, false);
        assert.equal(limiter.check('a', WINDOW).ok, true);
    });

    test('round a wait up to a whole second', () => {
        const limiter = make(1);
        limiter.check('a', 0);

        assert.equal(limiter.check('a', 1).retryAfter, 10);
        assert.equal(limiter.check('a', 8999).retryAfter, 2);
        assert.equal(limiter.check('a', 9000).retryAfter, 1);
    });

    test('never tell to wait less than a second nor more than the window', () => {
        const limiter = createLimiter({ window: 500, client: 1 });
        limiter.check('a', 0);

        assert.equal(limiter.check('a', 499).retryAfter, 1);
        assert.equal(limiter.check('a', 0).retryAfter, 1);
    });
});

describe('refused requests', () => {
    test('count nowhere, so a client that insists is let through when its window empties', () => {
        const limiter = make(2);
        limiter.check('a', 0);
        limiter.check('a', 1);
        for (let time = 2; time < 10_000; time += 100) assert.equal(limiter.check('a', time).ok, false);

        assert.equal(limiter.check('a', 10_000).ok, true);
        assert.equal(limiter.check('a', 10_001).ok, true);
        assert.equal(limiter.check('a', 10_002).ok, false);
    });

    test('do not use the global cap, so a refused client leaves room to the others', () => {
        const limiter = make(1, 2);

        assert.equal(limiter.check('a', 0).ok, true);
        assert.equal(limiter.check('a', 1).ok, false);
        assert.equal(limiter.check('a', 2).ok, false);
        assert.equal(limiter.check('b', 3).ok, true);
        assert.deepEqual(limiter.check('c', 4), { ok: false, scope: 'global', limit: 2, retryAfter: 10 });
    });

    test('do not charge the client that the global cap refused', () => {
        const limiter = make(1, 1);
        limiter.check('a', 0);

        assert.equal(limiter.check('b', 1).ok, false);
        assert.equal(limiter.check('b', WINDOW).ok, true);
        assert.equal(limiter.check('b', WINDOW + 1).ok, false);
    });

    test('carry no remaining and no reset', () => {
        const limiter = make(1);
        limiter.check('a', 0);

        assert.deepEqual(Object.keys(limiter.check('a', 1)).sort(), ['limit', 'ok', 'retryAfter', 'scope']);
    });
});

describe('per-call limit', () => {
    test('replace the cap of the options for that call', () => {
        const limiter = make(5);

        assert.deepEqual(limiter.check('a', 0, 1), { ok: true, limit: 1, remaining: 0, reset: 10 });
        assert.deepEqual(limiter.check('a', 1, 1), { ok: false, scope: 'client', limit: 1, retryAfter: 10 });
        assert.equal(limiter.check('a', 2, 3).ok, true);
        assert.equal(limiter.check('a', 3, 3).ok, true);
        assert.deepEqual(limiter.check('a', 4, 3), { ok: false, scope: 'client', limit: 3, retryAfter: 10 });
    });

    test('wait for enough requests to leave when the limit fell below the count of the key', () => {
        const limiter = make(10);
        for (const time of [0, 1000, 2000, 3000]) limiter.check('a', time);

        assert.deepEqual(limiter.check('a', 4000, 2), { ok: false, scope: 'client', limit: 2, retryAfter: 8 });
        assert.equal(limiter.check('a', 11_999, 2).ok, false);
        assert.deepEqual(limiter.check('a', 12_000, 2), { ok: true, limit: 2, remaining: 0, reset: 1 });
    });

    test('allow more than the cap of the options', () => {
        const limiter = make(1);

        for (let index = 0; index < 50; index++) assert.equal(limiter.check('a', index, 50).ok, true);
        assert.equal(limiter.check('a', 50, 50).ok, false);
    });

    test('count the requests of another call against the new cap', () => {
        const limiter = make(10);
        for (let index = 0; index < 4; index++) limiter.check('a', index);

        assert.equal(limiter.check('a', 4, 4).ok, false);
        assert.deepEqual(limiter.check('a', 5, 6), { ok: true, limit: 6, remaining: 1, reset: 10 });
    });
});

describe('global cap', () => {
    test('refuse every key once the window holds the cap, and open the next window on time', () => {
        const limiter = make(10, 3);
        for (const key of ['a', 'b', 'c']) assert.equal(limiter.check(key, 0).ok, true);

        assert.deepEqual(limiter.check('d', 1), { ok: false, scope: 'global', limit: 3, retryAfter: 10 });
        assert.deepEqual(limiter.check('a', 9999), { ok: false, scope: 'global', limit: 3, retryAfter: 1 });
        assert.equal(limiter.check('d', 10_000).ok, true);
    });

    test('open the first window at the first check, not at the creation', () => {
        const limiter = make(10, 1);

        assert.equal(limiter.check('a', 5000).ok, true);
        assert.equal(limiter.check('b', 14_999).ok, false);
        assert.equal(limiter.check('b', 15_000).ok, true);
    });

    test('count over a fixed window, unlike the keys', () => {
        const limiter = make(10, 2);

        assert.equal(limiter.check('a', 0).ok, true);
        assert.equal(limiter.check('b', 9999).ok, true);
        assert.equal(limiter.check('c', 9999).ok, false);
        assert.equal(limiter.check('c', 10_000).ok, true);
        assert.equal(limiter.check('d', 10_000).ok, true);
        assert.equal(limiter.check('e', 10_000).ok, false);
    });

    test('win over the per-key cap when both are reached', () => {
        const limiter = make(1, 1);
        limiter.check('a', 0);

        assert.deepEqual(limiter.check('a', 1), { ok: false, scope: 'global', limit: 1, retryAfter: 10 });
    });

    test('report the per-key cap when only that one is reached', () => {
        const limiter = make(1, 5);
        limiter.check('a', 0);

        assert.equal(limiter.check('a', 1).scope, 'client');
    });
});

describe('keys', () => {
    test('treat the names of Object.prototype as plain keys', () => {
        const limiter = make(1);

        for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '']) {
            assert.equal(limiter.check(key, 0).ok, true, `${key} first`);
            assert.equal(limiter.check(key, 1).ok, false, `${key} second`);
        }
    });

    test('tell apart keys that differ by case or by a space', () => {
        const limiter = make(1);

        for (const key of ['a', 'A', 'a ', ' a']) assert.equal(limiter.check(key, 0).ok, true, key);
    });
});

describe('independence', () => {
    test('share no counter between two limiters', () => {
        const first = make(1, 1);
        const second = make(1, 1);

        assert.equal(first.check('a', 0).ok, true);
        assert.equal(first.check('b', 0).ok, false);
        assert.equal(second.check('b', 0).ok, true);
    });
});

describe('sweep', () => {
    test('drop the keys that left the window, once per window', () => {
        // The sweep is only visible through the deletes it makes, so Map.prototype is patched for this test alone
        const drop = mock.method(Map.prototype, 'delete');
        try {
            const limiter = make(5);
            for (let index = 0; index < 100; index++) limiter.check(`idle${index}`, 0);
            limiter.check('busy', WINDOW - 1);
            limiter.check('late', 1);
            drop.mock.resetCalls();

            limiter.check('busy', WINDOW);
            assert.equal(drop.mock.callCount(), 100);

            limiter.check('busy', WINDOW + 1);
            assert.equal(drop.mock.callCount(), 100);

            limiter.check('busy', 2 * WINDOW);
            assert.equal(drop.mock.callCount(), 101);
        } finally {
            drop.mock.restore();
        }
    });

    test('keep a key that has a request in the window when the sweep runs, with every decision', () => {
        const limiter = make(2);
        limiter.check('busy', 1);
        limiter.check('busy', 10_000);

        assert.deepEqual(limiter.check('busy', 10_001), { ok: true, limit: 2, remaining: 0, reset: 10 });
        assert.deepEqual(limiter.check('busy', 10_002), { ok: false, scope: 'client', limit: 2, retryAfter: 10 });
    });

    test('forget an idle key, which starts again from nothing', () => {
        const limiter = make(1);
        limiter.check('idle', 0);
        limiter.check('other', 5000);

        assert.deepEqual(limiter.check('idle', 25_000), { ok: true, limit: 1, remaining: 0, reset: 10 });
    });
});

describe('clock', () => {
    test('tell a key to wait at most the window, rounded up, when the clock went back', () => {
        const limiter = createLimiter({ window: 2500, client: 1 });
        limiter.check('a', 50_000);

        assert.deepEqual(limiter.check('a', 0), { ok: false, scope: 'client', limit: 1, retryAfter: 3 });
        assert.equal(limiter.check('a', 100_000).ok, true);
    });

    test('tell every key to wait at most the window when the clock went back before the global window', () => {
        const limiter = createLimiter({ window: 2500, client: 5, global: 1 });
        limiter.check('a', 50_000);

        assert.deepEqual(limiter.check('b', 0), { ok: false, scope: 'global', limit: 1, retryAfter: 3 });
    });

    test('never answer a wait of zero, whatever the fraction of the clock', () => {
        const limiter = createLimiter({ window: 1, client: 1 });
        const first = 0.1322008927585557;
        const edge = 1.1322008927585556;
        limiter.check('a', first);

        assert.deepEqual(limiter.check('a', edge), { ok: false, scope: 'client', limit: 1, retryAfter: 1 });

        const roomy = createLimiter({ window: 1, client: 2 });
        roomy.check('a', first);

        assert.deepEqual(roomy.check('a', edge), { ok: true, limit: 2, remaining: 0, reset: 1 });
    });

    test('work with a window of one millisecond', () => {
        const limiter = createLimiter({ window: 1, client: 1, global: 1 });

        assert.deepEqual(limiter.check('a', 0), { ok: true, limit: 1, remaining: 0, reset: 1 });
        assert.deepEqual(limiter.check('a', 0), { ok: false, scope: 'global', limit: 1, retryAfter: 1 });
        assert.equal(limiter.check('a', 1).ok, true);
    });

    test('round a window that is not a whole number of seconds up', () => {
        const limiter = createLimiter({ window: 1500, client: 1 });
        limiter.check('a', 0);

        assert.equal(limiter.check('a', 1).retryAfter, 2);
        assert.equal(limiter.check('a', 1499).retryAfter, 1);
    });

    test('answer the same for the same clock', () => {
        const run = () => {
            const limiter = make(2, 3);
            return [0, 1, 2, 3, 10_000, 10_001, 10_002].map((time, index) => limiter.check(`k${index % 2}`, time));
        };

        assert.deepEqual(run(), run());
    });
});
