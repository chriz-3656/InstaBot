export async function withRetry<T>(
	task: () => Promise<T>,
	options?: {
		retries?: number;
		baseDelayMs?: number;
	},
): Promise<T> {
	const retries = options?.retries ?? 3;
	const baseDelayMs = options?.baseDelayMs ?? 300;

	const attemptTask = async (attempt: number): Promise<T> => {
		try {
			return await task();
		} catch (error) {
			if (attempt === retries) {
				throw error;
			}

			const delay = baseDelayMs * 2 ** attempt;
			await new Promise<void>(resolve => {
				setTimeout(() => {
					resolve();
				}, delay);
			});
			return attemptTask(attempt + 1);
		}
	};

	return attemptTask(0);
}
