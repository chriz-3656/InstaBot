import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	type Client,
	type TextChannel,
	type DMChannel,
	type NewsChannel,
	type ThreadChannel,
} from 'discord.js';
import {type InstagramClient} from '../core/instagram/index.js';
import {type Message} from '../types/instagram.js';
import {createContextualLogger} from '../utils/logger.js';
import {buildReplyModal, buildSendModal} from '../discord/modals.js';
import {ThreadMapStore} from './thread-map-store.js';

const logger = createContextualLogger('DmRelay');

// Gradient-inspired colors for DM relay embeds
const RELAY_COLOR = 0x9b_59_b6; // Purple
const TEXT_MSG_COLOR = 0x58_65_f2; // Blurple
const MEDIA_COLOR = 0xe9_1e_63; // Pink
const LINK_COLOR = 0x34_98_db; // Blue
const SHARE_COLOR = 0xe6_7e_22; // Orange

function buildMessageEmbed(
	message: Message,
	account: string,
): {embed: EmbedBuilder; components: Array<ActionRowBuilder<ButtonBuilder>>} {
	const embed = new EmbedBuilder()
		.setAuthor({
			name: message.username,
			iconURL: message.isOutgoing ? undefined : undefined,
		})
		.setFooter({text: `Instagram • @${account}`})
		.setTimestamp(message.timestamp)
		.setColor(RELAY_COLOR);

	const {repliedTo} = message;
	if (repliedTo) {
		embed.addFields({
			name: `\u{21A9}\u{FE0F} Replying to ${repliedTo.username}`,
			value: repliedTo.text
				? repliedTo.text.slice(0, 200)
				: '[non-text message]',
		});
	}

	switch (message.itemType) {
		case 'text': {
			embed.setColor(TEXT_MSG_COLOR).setDescription(message.text);
			break;
		}

		case 'link': {
			embed
				.setColor(LINK_COLOR)
				.setTitle(message.link.text.slice(0, 256))
				.setURL(message.link.url)
				.setDescription(message.link.url);
			break;
		}

		case 'placeholder': {
			embed.setColor(RELAY_COLOR).setDescription(message.text);
			break;
		}

		case 'media_share': {
			const post = message.mediaSharePost;
			const caption = post.caption?.text;
			embed
				.setColor(SHARE_COLOR)
				.setTitle('\u{1F4F0} Shared Post')
				.setDescription(caption ? caption.slice(0, 500) : 'Shared a post');
			if (post.user?.username) {
				embed.setFooter({
					text: `Instagram • @${account} • from @${post.user.username}`,
				});
			}

			break;
		}

		case 'media': {
			const mediaType = message.media.media_type === 2 ? 'video' : 'photo';
			const dimensions = `${message.media.original_width}\u00D7${message.media.original_height}`;
			embed
				.setColor(MEDIA_COLOR)
				.setDescription(`\u{1F4F7} **${mediaType}** (${dimensions})`);
			break;
		}

		default: {
			embed.setDescription('[unsupported message type]');
		}
	}

	if (message.reactions && message.reactions.length > 0) {
		const reactionStr = message.reactions
			.map(r => r.emoji)
			.slice(0, 10)
			.join(' ');
		embed.addFields({
			name: 'Reactions',
			value: reactionStr,
			inline: true,
		});
	}

	// Quick action buttons
	const components = [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`ig:quick:reply:${message.threadId}:${message.id}`)
				.setLabel('Reply')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`ig:quick:openthread:${message.threadId}`)
				.setLabel('Open Thread')
				.setStyle(ButtonStyle.Secondary),
		),
	];

	return {embed, components};
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

				const textChannel = channel as
					| TextChannel
					| DMChannel
					| NewsChannel
					| ThreadChannel;
				const {embed, components} = buildMessageEmbed(message, account);
				await textChannel.send({
					embeds: [embed],
					components,
				});
			} catch (error) {
				logger.error('Failed to relay incoming IG message to Discord', error);
			}
		});

		// Handle quick action button interactions
		discordClient.on('interactionCreate', async interaction => {
			if (!interaction.isButton()) return;

			const {customId} = interaction;
			if (!customId.startsWith('ig:quick:')) return;

			const parts = customId.split(':');
			const action = parts[2];

			if (action === 'reply') {
				const threadId = parts[3];
				const messageId = parts[4];
				if (!threadId || !messageId) return;

				await interaction.showModal(buildReplyModal(threadId, messageId));
			}

			if (action === 'openthread') {
				const threadId = parts[3];
				if (!threadId) return;

				await interaction.showModal(buildSendModal(threadId));
			}
		});
	}
}
