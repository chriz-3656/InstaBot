import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	InstagramClient,
	ConfigManager,
	SessionManager,
} from '../core/instagram/index.js';
import {createContextualLogger} from '../utils/logger.js';

const logger = createContextualLogger('DiscordAccountManager');

export class DiscordAccountManager {
	private readonly clients = new Map<string, InstagramClient>();
	private readonly config = ConfigManager.getInstance();

	public async resolveAccountName(preferred?: string): Promise<string> {
		if (preferred) {
			return preferred;
		}

		await this.config.initialize();
		const fromConfig = this.config.get<string | undefined>(
			'login.currentUsername',
		);
		if (!fromConfig) {
			const fromEnv = process.env['IG_DEFAULT_ACCOUNT'];
			if (fromEnv) {
				return fromEnv;
			}

			const defaultAccount = this.config.get<string | undefined>(
				'login.defaultUsername',
			);
			if (!defaultAccount) {
				throw new Error(
					'No Instagram account available. Run npm run auth:login first.',
				);
			}

			return defaultAccount;
		}

		return fromConfig;
	}

	public async listAvailableAccounts(): Promise<string[]> {
		await this.config.initialize();
		const usersDir = this.config.get('advanced.usersDir');

		try {
			const entries = await fs.readdir(usersDir, {withFileTypes: true});
			const accounts = entries
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name)
				.filter(Boolean);

			const available: string[] = [];
			for (const account of accounts) {
				const sessionPath = path.join(usersDir, account, 'session.ts.json');
				// eslint-disable-next-line no-await-in-loop
				const hasSession = await fs
					.access(sessionPath)
					.then(() => true)
					.catch(() => false);
				if (hasSession) {
					available.push(account);
				}
			}

			return available.sort();
		} catch {
			return [];
		}
	}

	public async getCurrentAccount(): Promise<string | undefined> {
		await this.config.initialize();
		return this.config.get<string | undefined>('login.currentUsername');
	}

	public async useAccount(account: string): Promise<void> {
		const sessionManager = new SessionManager(account);
		const hasSession = await sessionManager.sessionExists();
		if (!hasSession) {
			throw new Error(
				`No session found for "${account}". Run npm run auth:login.`,
			);
		}

		await this.config.initialize();
		await this.config.set('login.currentUsername', account);
		const defaultAccount = this.config.get<string | undefined>(
			'login.defaultUsername',
		);
		if (!defaultAccount) {
			await this.config.set('login.defaultUsername', account);
		}
	}

	public async getClient(preferred?: string): Promise<{
		account: string;
		client: InstagramClient;
	}> {
		const account = await this.resolveAccountName(preferred);

		const cached = this.clients.get(account);
		if (cached) {
			return {account, client: cached};
		}

		const sessionManager = new SessionManager(account);
		const sessionExists = await sessionManager.sessionExists();
		if (!sessionExists) {
			throw new Error(
				`No session found for "${account}". Login via existing session flow first.`,
			);
		}

		const client = new InstagramClient(account);
		const result = await client.loginBySession({initializeRealtime: true});
		if (!result.success) {
			throw new Error(result.error ?? `Failed to login account "${account}"`);
		}

		logger.info(`Instagram account connected: ${account}`);
		this.clients.set(account, client);
		return {account, client};
	}

	public async shutdown(): Promise<void> {
		await Promise.all(
			[...this.clients.values()].map(async client => {
				try {
					await client.shutdown();
				} catch {}
			}),
		);
		this.clients.clear();
	}
}
