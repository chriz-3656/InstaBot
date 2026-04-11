import {createContextualLogger} from '../../utils/logger.js';
import {type InstagramClient} from './client.js';

const logger = createContextualLogger('ThreadResolver');

/**
 * Resolves a thread identifier to a concrete thread ID.
 * Supports raw thread IDs, exact usernames, and fuzzy thread titles.
 */
export async function resolveThread(
	client: InstagramClient,
	query: string,
): Promise<{threadId: string; userPk?: string}> {
	if (/^\d{20,}$/.test(query)) {
		return {threadId: query};
	}

	try {
		const results = await client.searchThreadByUsername(query, {
			forceExact: true,
		});
		if (results.length > 0 && results[0]) {
			const {thread} = results[0];
			let threadId = thread.id;
			const userPk = thread.users[0]?.pk ?? '';
			if (threadId.startsWith('PENDING_')) {
				const pk = threadId.replace('PENDING_', '');
				const realThread = await client.ensureThread(pk);
				threadId = realThread.id;
			}

			return {threadId, userPk};
		}
	} catch (error) {
		logger.warn(
			`Failed to resolve thread by username, falling back to title search: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const titleResults = await client.searchThreadsByTitle(query);
	if (titleResults.length > 0 && titleResults[0]) {
		return {threadId: titleResults[0].thread.id};
	}

	throw new Error(`No thread found matching "${query}"`);
}
