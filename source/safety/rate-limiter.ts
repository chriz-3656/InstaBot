type Bucket = {
	tokens: number;
	lastRefillMs: number;
};

export class RateLimiter {
	private readonly buckets = new Map<string, Bucket>();
	private readonly maxTokens: number;
	private readonly refillIntervalMs: number;

	constructor(maxTokens = 5, refillIntervalMs = 1000) {
		this.maxTokens = maxTokens;
		this.refillIntervalMs = refillIntervalMs;
	}

	public async take(key: string): Promise<void> {
		while (true) {
			const now = Date.now();
			const bucket = this.buckets.get(key) ?? {
				tokens: this.maxTokens,
				lastRefillMs: now,
			};

			const elapsed = now - bucket.lastRefillMs;
			if (elapsed >= this.refillIntervalMs) {
				const refillSteps = Math.floor(elapsed / this.refillIntervalMs);
				bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refillSteps);
				bucket.lastRefillMs = now;
			}

			if (bucket.tokens > 0) {
				bucket.tokens--;
				this.buckets.set(key, bucket);
				return;
			}

			this.buckets.set(key, bucket);
			// eslint-disable-next-line no-await-in-loop
			await new Promise<void>(resolve => {
				setTimeout(resolve, this.refillIntervalMs / 10);
			});
		}
	}
}
