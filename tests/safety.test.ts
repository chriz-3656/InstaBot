/* eslint-disable @typescript-eslint/no-unsafe-call */

import test from 'ava';
import {AsyncQueue} from '../source/safety/queue.js';
import {withRetry} from '../source/safety/retry.js';

test('AsyncQueue executes tasks in order for the same key', async t => {
	const queue = new AsyncQueue();
	const events: string[] = [];

	await Promise.all([
		queue.enqueue('k', async () => {
			events.push('a-start');
			await new Promise<void>(resolve => {
				setTimeout(() => {
					resolve();
				}, 20);
			});
			events.push('a-end');
		}),
		queue.enqueue('k', async () => {
			events.push('b');
		}),
	]);

	t.deepEqual(events, ['a-start', 'a-end', 'b']);
});

test('withRetry retries and eventually resolves', async t => {
	let attempts = 0;
	const value = await withRetry(async () => {
		attempts++;
		if (attempts < 3) {
			throw new Error('transient');
		}

		return 'ok';
	});

	t.is(value, 'ok');
	t.is(attempts, 3);
});
