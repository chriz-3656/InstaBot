import {type Client} from 'discord.js';
import {type InstagramClient} from '../core/instagram/index.js';
import {type Message} from '../types/instagram.js';
import {createContextualLogger} from '../utils/logger.js';
import {ThreadMapStore} from './thread-map-store.js';

const logger = createContextualLogger('DmRelay');

function formatMessage(message: Message): string {
	if (message.itemType === 'text') {
		return message.text;
	}

	if (message.itemType === 'link') {
		return `${message.link.text} (${message.link.url})`;
	}

	if (message.itemType === 'placeholder') {
		return message.text;
	}

	if (message.itemType === 'media_share') {
		return '[media share]';
	}

	return '[media]';
}

export class DmRelay {
	private readonly mapStore = new ThreadMapStore();

	public async initialize(): Promise<void> {
		await this.mapStore.initialize();
	}

	public async mapThreadToChannel(
		account: string,
		threadId: string,
		channelId: string,
	): Promise<void> {
		await this.mapStore.setChannelId(account, threadId, channelId);
	}

	public async attachAccount(
		discordClient: Client,
		account: string,
		instagramClient: InstagramClient,
	): Promise<void> {
		await this.initialize();

		instagramClient.on('message', async (message: Message) => {
			if (message.isOutgoing) {
				return;
			}

			try {
				const channelId = await this.mapStore.getChannelId(
					account,
					message.threadId,
				);
				if (!channelId) {
					return;
				}

				const channel = await discordClient.channels.fetch(channelId);
				if (!channel?.isTextBased() || !('send' in channel)) {
					return;
				}

				await channel.send(
					`[IG/${account}] @${message.username}: ${formatMessage(message)}`,
				);
			} catch (error) {
				logger.error('Failed to relay incoming IG message to Discord', error);
			}
		});
	}
}
