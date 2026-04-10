export class AsyncQueue {
	private readonly tails = new Map<string, Promise<unknown>>();

	public async enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
		const tail = this.tails.get(key) ?? Promise.resolve();
		const next = tail.then(task, task);

		this.tails.set(
			key,
			next.finally(() => {
				if (this.tails.get(key) === next) {
					this.tails.delete(key);
				}
			}),
		);

		return next;
	}
}
