import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import process from 'node:process';
import {type Client as DiscordClient, TextChannel} from 'discord.js';
import {type InstagramClient} from '../core/instagram/index.js';
import {createContextualLogger} from '../utils/logger.js';

const logger = createContextualLogger('NotificationPoller');

const DATA_PATH = join(process.cwd(), 'data', 'notification_state.json');

type NotificationState = {
	accounts: Record<
		string,
		{
			followerIds: string[];
			lastFollowerCheck: number;
			lastMentionCheck: number;
			enabled: {followers: boolean; mentions: boolean};
		}
	>;
};

function loadState(): NotificationState {
	if (!existsSync(DATA_PATH)) {
		return {accounts: {}};
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
	} catch {
		return {accounts: {}};
	}
}

function saveState(state: NotificationState): void {
	mkdirSync(join(process.cwd(), 'data'), {recursive: true});
	writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
}

export class NotificationPoller {
	private readonly state: NotificationState;
	private intervalId: NodeJS.Timeout | undefined = undefined;
	private readonly pollIntervalMs: number;

	constructor(pollIntervalMs = 5 * 60 * 1000) {
		// Default: 5 minutes
		this.state = loadState();
		this.pollIntervalMs = pollIntervalMs;
	}

	public async start(
		discordClient: DiscordClient,
		getClient: (account: string) => InstagramClient | undefined,
		getCurrentAccount: () => Promise<string | undefined>,
	): Promise<void> {
		if (this.intervalId) return;

		logger.info(
			`Starting notification poller (every ${this.pollIntervalMs / 1000}s)`,
		);
		this.intervalId = setInterval(async () => {
			const account = await getCurrentAccount();
			if (!account) return;

			const client = getClient(account);
			if (!client) return;

			const accountState = this.state.accounts[account];
			if (!accountState) return;

			// Check followers
			if (accountState.enabled.followers) {
				await this.checkFollowers(account, client, discordClient, accountState);
			}

			// Check mentions
			if (accountState.enabled.mentions) {
				await this.checkMentions(account, client, discordClient, accountState);
			}
		}, this.pollIntervalMs);
	}

	public stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
			logger.info('Notification poller stopped');
		}
	}

	public toggleSetting(
		account: string,
		type: 'followers' | 'mentions',
	): boolean {
		this.state.accounts[account] ??= {
			followerIds: [],
			lastFollowerCheck: 0,
			lastMentionCheck: 0,
			enabled: {followers: false, mentions: false},
		};

		this.state.accounts[account].enabled[type] =
			!this.state.accounts[account].enabled[type];
		saveState(this.state);

		return this.state.accounts[account].enabled[type];
	}

	public async initializeAccount(
		account: string,
		client: InstagramClient,
	): Promise<void> {
		if (this.state.accounts[account]) return;

		const {allFollowerIds} = await client.getNewFollowers();
		this.state.accounts[account] = {
			followerIds: [...allFollowerIds],
			lastFollowerCheck: Date.now(),
			lastMentionCheck: Date.now(),
			enabled: {followers: false, mentions: false},
		};
		saveState(this.state);
		logger.info(`Initialized notification state for @${account}`);
	}

	private async checkFollowers(
		account: string,
		client: InstagramClient,
		discordClient: DiscordClient,
		accountState: NotificationState['accounts'][string],
	): Promise<void> {
		try {
			const {newFollowers, allFollowerIds} = await client.getNewFollowers(
				new Set(accountState.followerIds),
			);

			if (newFollowers.length > 0) {
				const channelId = await this.findNotifyChannel(discordClient);
				if (channelId) {
					const channel = await discordClient.channels.fetch(channelId);
					if (channel instanceof TextChannel) {
						const names = newFollowers.slice(0, 10).join(', ');
						const more =
							newFollowers.length > 10
								? ` and ${newFollowers.length - 10} more`
								: '';
						await channel.send({
							embeds: [
								{
									title: '\u{1F514} New Followers',
									description: `@${account} gained **${newFollowers.length}** new follower(s):\n\n${names}${more}`,
									color: 0x57_f2_87,
									timestamp: new Date().toISOString(),
									footer: {text: `Account: @${account}`},
								},
							],
						});
					}
				}
			}

			// Update state
			accountState.followerIds = [...allFollowerIds];
			accountState.lastFollowerCheck = Date.now();
			saveState(this.state);
		} catch (error) {
			logger.error(`Failed to check followers for @${account}`, error);
		}
	}

	private async checkMentions(
		account: string,
		client: InstagramClient,
		discordClient: DiscordClient,
		accountState: NotificationState['accounts'][string],
	): Promise<void> {
		try {
			const lastCheck = new Date(accountState.lastMentionCheck);
			const mentions = await client.getMentions(10);

			// Filter to only new mentions since last check
			const newMentions = mentions.filter(m => m.timestamp > lastCheck);

			if (newMentions.length > 0) {
				const channelId = await this.findNotifyChannel(discordClient);
				if (channelId) {
					const channel = await discordClient.channels.fetch(channelId);
					if (channel instanceof TextChannel) {
						const sendPromises = newMentions.slice(0, 5).map(async mention =>
							channel.send({
								embeds: [
									{
										title: '\u{1F4DB} You were mentioned!',
										description:
											`**@${mention.user.username}** mentioned you\n\n` +
											(mention.caption
												? `"${mention.caption.slice(0, 200)}"`
												: '[No caption]'),
										color: 0x58_65_f2,
										thumbnail: mention.mediaUrl
											? {url: mention.mediaUrl}
											: undefined,
										timestamp: mention.timestamp.toISOString(),
										footer: {text: `Account: @${account}`},
									},
								],
							}),
						);
						await Promise.all(sendPromises);
					}
				}
			}

			// Update state
			accountState.lastMentionCheck = Date.now();
			saveState(this.state);
		} catch (error) {
			logger.error(`Failed to check mentions for @${account}`, error);
		}
	}

	private async findNotifyChannel(
		discordClient: DiscordClient,
	): Promise<string | undefined> {
		const channels = discordClient.channels.cache.filter(
			ch => ch instanceof TextChannel,
		);
		return channels.first()?.id;
	}
}
