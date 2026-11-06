# @moxon/limiter

A small rate limiter with a per-key sliding window and an optional global cap. The caller gives the clock, so it reads no time, runs no timer and works on any JavaScript runtime.

## Features

- **Per-key sliding window**: a key may make `client` requests over any window of `window` milliseconds
- **Global cap**: `global` limits all the keys together over a fixed window, and is looked at first
- **Per-call limit**: a limit given to one call replaces the cap of the key, for a plan per token for instance
- **Answers made for headers**: `remaining`, `reset` and `retryAfter` come in whole seconds, ready for `Retry-After` and `X-RateLimit-*`
- **Refused requests count nowhere**: a client that keeps asking is let through again as soon as its window empties
- **The caller gives the clock**: no time is read and no timer runs, so a test drives it with any number
- **TypeScript types** included, ESM only, zero runtime dependencies

## Requirements

- Node.js 22.12 or later, or any runtime that runs ES2022 modules: the code uses no Node API

## Installation

```console
npm install @moxon/limiter
```

## Usage

### Import

```js
import { createLimiter } from '@moxon/limiter';
```

### Create a limiter

```js
const limiter = createLimiter({
    window: 10_000, // Length of the window in milliseconds
    client: 100, // Requests one key may make over any window
    global: 1000, // Requests all the keys together may make over a fixed window, none if omitted
});
```

### Check a request

```js
const decision = limiter.check(ip, Date.now());

if (decision.ok) {
    // Let it through: decision.remaining requests are left, the oldest leaves the window in decision.reset seconds
} else {
    // Refuse it: decision.scope is 'client' or 'global', decision.retryAfter is the seconds to wait
}
```

A request that passes is counted, a request that is refused counts nowhere.

### Global cap

The global cap is looked at first and counts over a fixed window, which opens at the first check and again at the first check after it ended. Without `global`, only the keys are capped.

```js
const decision = limiter.check(ip, Date.now());

if (!decision.ok && decision.scope === 'global') {
    // Every key is refused until the window of the server ends
}
```

### Per-call limit

The third argument replaces the `client` cap for one call, for a plan per token for instance.

```js
const plan = plans[token] ?? plans.free;
const decision = limiter.check(ip, Date.now(), plan.perWindow);
```

### Answer an HTTP request

With `node:http`, the address of the connection names the client:

```js
import http from 'node:http';

http.createServer((req, res) => {
    const decision = limiter.check(req.socket.remoteAddress, Date.now());

    if (!decision.ok) {
        res.writeHead(429, { 'Retry-After': decision.retryAfter });
        res.end('Too many requests.');
        return;
    }

    res.setHeader('X-RateLimit-Limit', decision.limit);
    res.setHeader('X-RateLimit-Remaining', decision.remaining);
    res.end('ok');
});
```

With a handler that speaks `fetch`, behind a proxy that rewrites a header with the address of the client:

```js
export default async function handler(request) {
    const decision = limiter.check(request.headers.get('x-client-ip') ?? '', Date.now());

    if (!decision.ok) {
        return new Response('Too many requests.', {
            status: 429,
            headers: { 'Retry-After': String(decision.retryAfter) },
        });
    }

    return new Response('ok');
}
```

No message is built: the text of a refusal belongs to the caller.

### Several limiters

A limiter has one window, so a burst limit and an hourly limit are two limiters, checked one after the other. A request counts in a limiter only when that limiter lets it through.

```js
const burst = createLimiter({ window: 10_000, client: 20 });
const hourly = createLimiter({ window: 3_600_000, client: 1000 });

const now = Date.now();
const decision = burst.check(ip, now);
const answer = decision.ok ? hourly.check(ip, now) : decision;
```

### Test with a fake clock

The clock is a number you give, so a test needs no timer to cross a window:

```js
const limiter = createLimiter({ window: 1000, client: 1 });

limiter.check('a', 0).ok; // true
limiter.check('a', 999).ok; // false, retryAfter is 1
limiter.check('a', 1000).ok; // true, the first request is a whole window old
```

## How it works

A key is counted over a sliding window: a request stays counted until it is `window` milliseconds old. With `window: 10_000` and `client: 3`, requests at 0, 2000 and 4000 fill the cap, a request at 5000 is refused with `retryAfter: 5`, and a request at 10_000 passes because the first one left.

The global cap is counted over a fixed window instead: it opens at the first check and again at the first check after it ended, and every request that passes counts in it.

Idle keys are swept by the checks themselves, once per window, so no timer runs.

## Details

### `createLimiter(options)`

| Option   | Description                                                                  |
| -------- | ---------------------------------------------------------------------------- |
| `window` | Length of the window in milliseconds                                         |
| `client` | Requests one key may make over any window (sliding)                          |
| `global` | Requests all the keys together may make over a fixed window; none if omitted |

Every value is an integer of 1 or more, else a `RangeError` is thrown.

### `limiter.check(key, now, limit?)`

Decides one request and, when it passes, counts it. `now` is a finite time in milliseconds from a clock that does not go back. `limit` replaces the `client` cap for this call. A `now` that is not finite, or a `limit` that is not an integer of 1 or more, throws a `RangeError`.

| Answer                                              | Meaning                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `{ ok: true, limit, remaining, reset }`             | Let through; `remaining` requests are left and the oldest leaves the window in `reset` seconds |
| `{ ok: false, scope: 'client', limit, retryAfter }` | The key reached its cap                                                                        |
| `{ ok: false, scope: 'global', limit, retryAfter }` | All the keys reached the global cap, which is looked at first                                  |

`reset` and `retryAfter` are whole seconds, at least 1 and at most the window rounded up to whole seconds, ready for a `Retry-After` or `X-RateLimit-Reset` header.

### Notes

- A key is any string, `__proto__` included.
- A request that is refused counts nowhere, neither for its key nor for the global cap.
- A request that passes with a lowered `limit` while the key holds more requests than that gets a `retryAfter` that waits for enough of them to leave.
- A key keeps one time per request in the window, so a cap of 100 holds at most 100 times per key; without a global cap, the number of keys of one window is only bounded by what the caller sends.

### Public exports

```js
import {
    createLimiter, // Create a limiter from a window, a per-key cap and an optional global cap
} from '@moxon/limiter';
```

**TypeScript types:**

```ts
import type {
    Allowed, // Answer of a request that passes
    Decision, // Allowed or Refused
    Limiter, // The object that createLimiter returns
    LimiterOptions, // Options of createLimiter
    Refused, // Answer of a request that is refused
} from '@moxon/limiter';
```

## Scripts

| Script           | Description                               |
| ---------------- | ----------------------------------------- |
| `npm run build`  | Compile TypeScript to `dist/`             |
| `npm test`       | Build, then run the tests (`node --test`) |
| `npm run check`  | Type check, ESLint and Prettier           |
| `npm run format` | Prettier and ESLint, writing the changes  |

## License

[BSD-3-Clause](LICENSE)
