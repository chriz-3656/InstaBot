import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	ModalBuilder,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
	ContainerBuilder,
	TextDisplayBuilder,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
	type APIMessageComponent,
} from 'discord.js';
import {type DmRelay} from '../../bridge/dm-relay.js';
import {type NotificationPoller} from '../../bridge/notification-poller.js';
import {
	resolveThread,
	type InstagramClient,
	type SearchResult,
} from '../../core/instagram/index.js';
import {type AsyncQueue} from '../../safety/queue.js';
import {type RateLimiter} from '../../safety/rate-limiter.js';
import {withRetry} from '../../safety/retry.js';
import {type DiscordAccountManager} from '../account-manager.js';
import {buildReplyModal, buildSendModal} from '../modals.js';

type InboxThread = Awaited<
	ReturnType<InstagramClient['getThreads']>
>['threads'][number];

export type IgCommandContext = {
	accountManager: DiscordAccountManager;
	dmRelay: DmRelay;
	notificationPoller: NotificationPoller;
	rateLimiter: RateLimiter;
	queue: AsyncQueue;
	ensureRelayAttached: (
		account: string,
		client: InstagramClient,
	) => Promise<void>;
};

const EMBED_COLOR = 0x58_65_f2; // Discord blurple
const SUCCESS_COLOR = 0x57_f2_87; // Discord green
const ERROR_COLOR = 0xed_42_45; // Discord red

// Discord limits (used for safeTruncate in embed builders)
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 100;

const normalizeLimit = (value: string | undefined, fallback = 20): number => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.min(50, Math.max(1, Math.floor(parsed)));
};

const parseInteractiveId = (
	customId: string,
	expectedKind: string,
): string | undefined => {
	const parts = customId.split(':');
	if (parts.length < 3 || parts[0] !== 'ig' || parts[1] !== expectedKind) {
		return undefined;
	}

	return parts[2];
};

/**
 * Safely truncate a string to maxBytes, handling multi-byte UTF characters.
 */
const safeTruncate = (text: string, maxBytes: number): string => {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	if (bytes.length <= maxBytes) return text;

	// Truncate and decode back (handles multi-byte safely)
	const decoder = new TextDecoder();
	let truncated = decoder.decode(bytes.slice(0, maxBytes));
	// Remove incomplete trailing characters
	truncated = truncated.replace(/\uFFFD$/, '');
	return truncated;
};

const resolveClient = async (
	context: IgCommandContext,
): Promise<{account: string; client: InstagramClient}> => {
	const {account, client} = await context.accountManager.getClient();
	await context.ensureRelayAttached(account, client);
	return {account, client};
};

// --- Embed builders ---

const buildInboxEmbed = (
	threads: InboxThread[],
	limit: number,
	account: string,
): {
	embeds: EmbedBuilder[];
	components: Array<ActionRowBuilder<StringSelectMenuBuilder>>;
} => {
	if (threads.length === 0) {
		return {
			embeds: [
				new EmbedBuilder()
					.setColor(EMBED_COLOR)
					.setTitle('Instagram Inbox')
					.setDescription('No threads found.')
					.setFooter({text: `Account: @${account}`}),
			],
			components: [],
		};
	}

	const fields = threads.slice(0, limit).map(thread => {
		const lastMsg =
			thread.lastMessage && 'text' in thread.lastMessage
				? thread.lastMessage.text
				: thread.lastMessage
					? '[non-text message]'
					: 'No messages yet';

		const timeAgo = getTimeAgo(thread.lastActivity);
		const unreadIcon = thread.unread ? '\u{1F534} ' : ''; // red circle

		return {
			name: safeTruncate(`${unreadIcon}${thread.title}`, 256),
			value: safeTruncate(
				`${lastMsg.slice(0, 150)}${lastMsg.length > 150 ? '...' : ''}\n*${timeAgo}*`,
				1024,
			),
			inline: false,
		};
	});

	const embed = new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setTitle('Instagram Inbox')
		.setDescription(
			`Showing ${Math.min(threads.length, limit)} of ${threads.length} threads`,
		)
		.setFields(fields.slice(0, 25)) // Discord max 25 fields
		.setFooter({text: `Account: @${account} | ID: ${threads[0]?.id ?? 'N/A'}`})
		.setTimestamp();

	// Build select menu for thread navigation (max 25 options)
	const selectOptions = threads.slice(0, 25).map(thread => {
		const description =
			thread.lastMessage && 'text' in thread.lastMessage
				? `${thread.unread ? '[UNREAD] ' : ''}${(thread.lastMessage.text ?? '').slice(0, 80)}`
				: thread.unread
					? '[UNREAD] No messages'
					: 'No messages';

		return new StringSelectMenuOptionBuilder()
			.setLabel(safeTruncate(thread.title, MAX_LABEL_LENGTH))
			.setValue(`thread_${thread.id}`)
			.setDescription(safeTruncate(description, MAX_DESCRIPTION_LENGTH))
			.setEmoji(thread.unread ? '\u{1F534}' : '\u{26AA}');
	});

	const components: Array<ActionRowBuilder<StringSelectMenuBuilder>> = [];
	if (selectOptions.length > 0) {
		components.push(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				new StringSelectMenuBuilder()
					.setCustomId('ig:select:thread')
					.setPlaceholder('Select a thread...')
					.addOptions(selectOptions),
			),
		);
	}

	return {embeds: [embed], components};
};

const buildSearchEmbed = (
	results: SearchResult[],
	query: string,
	limit: number,
	account: string,
): {
	embeds: EmbedBuilder[];
	components: Array<ActionRowBuilder<StringSelectMenuBuilder>>;
} => {
	if (results.length === 0) {
		return {
			embeds: [
				new EmbedBuilder()
					.setColor(EMBED_COLOR)
					.setTitle('Search Results')
					.setDescription(`No threads matching "${query}".`)
					.setFooter({text: `Account: @${account}`}),
			],
			components: [],
		};
	}

	const fields = results.slice(0, limit).map(result => {
		const matchPercent = Math.round(result.score * 100);
		const emoji =
			matchPercent >= 80
				? '\u{1F7E2}'
				: matchPercent >= 50
					? '\u{1F7E1}'
					: '\u{1F534}';

		const lastMsg =
			result.thread.lastMessage && 'text' in result.thread.lastMessage
				? result.thread.lastMessage.text
				: 'No messages yet';

		return {
			name: safeTruncate(
				`${emoji} ${result.thread.title} (${matchPercent}%)`,
				256,
			),
			value: safeTruncate(
				`${lastMsg.slice(0, 120)}${lastMsg.length > 120 ? '...' : ''}`,
				1024,
			),
			inline: false,
		};
	});

	const embed = new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setTitle(`Search: "${safeTruncate(query, 256)}"`)
		.setDescription(`Found ${results.length} matching threads`)
		.setFields(fields.slice(0, 25))
		.setFooter({text: `Account: @${account}`})
		.setTimestamp();

	// Build select menu
	const selectOptions = results.slice(0, 25).map(result => {
		const matchPercent = Math.round(result.score * 100);
		return new StringSelectMenuOptionBuilder()
			.setLabel(safeTruncate(result.thread.title, MAX_LABEL_LENGTH))
			.setValue(`thread_${result.thread.id}`)
			.setDescription(`${matchPercent}% match`)
			.setEmoji(
				matchPercent >= 80
					? '\u{1F7E2}'
					: matchPercent >= 50
						? '\u{1F7E1}'
						: '\u{1F534}',
			);
	});

	const components: Array<ActionRowBuilder<StringSelectMenuBuilder>> = [];
	if (selectOptions.length > 0) {
		components.push(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				new StringSelectMenuBuilder()
					.setCustomId('ig:select:thread')
					.setPlaceholder('Select a thread to send message...')
					.addOptions(selectOptions),
			),
		);
	}

	return {embeds: [embed], components};
};

const buildSuccessEmbed = (
	title: string,
	description: string,
	account?: string,
): EmbedBuilder => {
	const embed = new EmbedBuilder()
		.setColor(SUCCESS_COLOR)
		.setTitle(title)
		.setDescription(description)
		.setTimestamp();
	if (account) {
		embed.setFooter({text: `Account: @${account}`});
	}

	return embed;
};

const buildErrorEmbed = (
	description: string,
	account?: string,
): EmbedBuilder => {
	const embed = new EmbedBuilder()
		.setColor(ERROR_COLOR)
		.setTitle('Error')
		.setDescription(description)
		.setTimestamp();
	if (account) {
		embed.setFooter({text: `Account: @${account}`});
	}

	return embed;
};

const buildAccountListEmbed = (
	accounts: string[],
	current: string | undefined,
): EmbedBuilder => {
	const lines = accounts.map(account => {
		const isActive = account === current;
		return isActive
			? `\u{2705} **${account}** _(active)_`
			: `\u{2B1C} ${account}`;
	});

	return new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setTitle('Instagram Accounts')
		.setDescription(lines.join('\n') || 'No saved accounts found.')
		.setFooter({text: `Use /ig account use <username> to switch`})
		.setTimestamp();
};

const buildProfileEmbed = (
	profile: {
		username: string;
		fullName: string;
		biography: string;
		followerCount: number;
		followingCount: number;
		mediaCount: number;
		isPrivate: boolean;
		isVerified: boolean;
		externalUrl?: string;
		profilePicUrl?: string;
	},
	account: string,
): EmbedBuilder => {
	const verificationBadge = profile.isVerified ? '\u{2705} ' : '';
	const privacyStatus = profile.isPrivate
		? '\u{1F512} Private'
		: '\u{1F310} Public';

	const embed = new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setTitle(`${verificationBadge}@${profile.username}`)
		.setDescription(
			`**${profile.fullName}**\n\n${profile.biography || 'No bio'}\n\n` +
				`\u{1F465} **Followers:** ${profile.followerCount.toLocaleString()}\n` +
				`\u{1F464} **Following:** ${profile.followingCount.toLocaleString()}\n` +
				`\u{1F4F7} **Posts:** ${profile.mediaCount.toLocaleString()}\n\n` +
				`${privacyStatus}`,
		)
		.setFooter({text: `Queried by @${account}`})
		.setTimestamp();

	if (profile.profilePicUrl) {
		embed.setThumbnail(profile.profilePicUrl);
	}

	if (profile.externalUrl) {
		embed.setURL(profile.externalUrl);
	}

	return embed;
};

const buildUnreadEmbed = (
	unreadThreads: Array<{
		title: string;
		unreadCount?: number;
		lastMessage?: string | {text: string};
		lastActivity: Date;
		id: string;
	}>,
	totalThreads: number,
	account: string,
): EmbedBuilder => {
	if (unreadThreads.length === 0) {
		return new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('All Caught Up!')
			.setDescription('\u{1F389} No unread messages.')
			.setFooter({text: `Account: @${account}`})
			.setTimestamp();
	}

	const fields = unreadThreads.map(thread => {
		const lastMsg =
			thread.lastMessage && typeof thread.lastMessage === 'object'
				? thread.lastMessage.text
				: (thread.lastMessage ?? 'No messages');

		return {
			name: safeTruncate(`\u{1F534} ${thread.title}`, 256),
			value: safeTruncate(
				`${lastMsg.slice(0, 100)}${lastMsg.length > 100 ? '...' : ''}\n*${getTimeAgo(thread.lastActivity)}*`,
				1024,
			),
			inline: false,
		};
	});

	return new EmbedBuilder()
		.setColor(ERROR_COLOR)
		.setTitle('Unread Messages')
		.setDescription(
			`You have **${unreadThreads.length}** unread thread(s) out of ${totalThreads} total.\n\n` +
				'\u{1F534} = Unread',
		)
		.setFields(fields.slice(0, 25))
		.setFooter({text: `Account: @${account}`})
		.setTimestamp();
};

// --- Execute functions that return structured data ---

const executeSend = async (
	context: IgCommandContext,
	account: string,
	client: InstagramClient,
	threadQuery: string,
	text: string,
	channelId: string,
): Promise<{threadId: string; messageId: string; threadTitle?: string}> => {
	const resolved = await resolveThread(client, threadQuery);
	const {threadId} = resolved;
	await context.dmRelay.mapThreadToChannel(account, threadId, channelId);

	const queueKey = `send:${account}:${threadId}`;
	const rateKey = `send:${account}`;
	const messageId = await context.queue.enqueue(queueKey, async () => {
		await context.rateLimiter.take(rateKey);
		return withRetry(async () => client.sendMessage(threadId, text));
	});

	return {threadId, messageId};
};

const executeReply = async (
	context: IgCommandContext,
	account: string,
	client: InstagramClient,
	threadQuery: string,
	replyToMessageId: string,
	text: string,
	channelId: string,
): Promise<{threadId: string; messageId: string; replyToUsername?: string}> => {
	const {threadId} = await resolveThread(client, threadQuery);
	await context.dmRelay.mapThreadToChannel(account, threadId, channelId);

	let replyToMessage;
	let cursor: string | undefined;
	let pages = 0;
	const maxPages = 10;
	do {
		// eslint-disable-next-line no-await-in-loop
		const result = await client.getMessages(threadId, cursor);
		replyToMessage = result.messages.find(
			message => message.id === replyToMessageId,
		);
		if (replyToMessage) {
			break;
		}

		cursor = result.cursor;
		pages++;
	} while (cursor && pages < maxPages);

	if (!replyToMessage) {
		throw new Error(
			`Message ${replyToMessageId} not found within ${maxPages} pages in thread ${threadId}.`,
		);
	}

	const resolvedReplyToMessage = replyToMessage;
	const queueKey = `reply:${account}:${threadId}`;
	const rateKey = `reply:${account}`;
	const replyMessageId = await context.queue.enqueue(queueKey, async () => {
		await context.rateLimiter.take(rateKey);
		return withRetry(async () =>
			client.sendReply(threadId, text, resolvedReplyToMessage),
		);
	});

	return {
		threadId,
		messageId: replyMessageId,
		replyToUsername: replyToMessage.username,
	};
};

// --- Panel rendering ---

const renderPanel = (): {
	content?: string;
	components: APIMessageComponent[];
} => {
	// Messaging buttons row
	const messagingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId('ig:btn:send')
			.setLabel('Send')
			.setStyle(ButtonStyle.Success)
			.setEmoji('\u{2709}\u{FE0F}'),
		new ButtonBuilder()
			.setCustomId('ig:btn:reply')
			.setLabel('Reply')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('\u{21A9}\u{FE0F}'),
		new ButtonBuilder()
			.setCustomId('ig:btn:unsend')
			.setLabel('Unsend')
			.setStyle(ButtonStyle.Danger)
			.setEmoji('\u{1F5D1}\u{FE0F}'),
	);

	// Inbox buttons row
	const inboxRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId('ig:btn:inbox')
			.setLabel('Inbox')
			.setStyle(ButtonStyle.Primary)
			.setEmoji('\u{1F4E5}'),
		new ButtonBuilder()
			.setCustomId('ig:btn:search')
			.setLabel('Search')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('\u{1F50D}'),
		new ButtonBuilder()
			.setCustomId('ig:btn:unread')
			.setLabel('Unread')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('\u{1F514}'),
	);

	// Tools buttons row
	const toolsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId('ig:btn:profile')
			.setLabel('Profile')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('\u{1F464}'),
		new ButtonBuilder()
			.setCustomId('ig:btn:notif-followers')
			.setLabel('Followers')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('\u{1F465}'),
		new ButtonBuilder()
			.setCustomId('ig:btn:notif-mentions')
			.setLabel('Mentions')
			.setStyle(ButtonStyle.Secondary)
			.setEmoji('\u{1F4DB}'),
	);

	// Container with V2 components
	const container = new ContainerBuilder()
		.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				'# \u{1F4F1} Instagram DM Manager\n' +
					'Manage your Instagram direct messages from Discord.',
			),
		)
		.addSeparatorComponents()
		.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				'## \u{2709}\u{FE0F} Messaging\n' +
					'**Send** - Message a thread | **Reply** - Reply to a message | **Unsend** - Delete a message',
			),
		)
		.addActionRowComponents(messagingRow)
		.addSeparatorComponents()
		.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				'## \u{1F4E5} Inbox\n' +
					'**Inbox** - View threads | **Search** - Find threads | **Unread** - Check unread chats',
			),
		)
		.addActionRowComponents(inboxRow)
		.addSeparatorComponents()
		.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				'## \u{1F6E0}\u{FE0F} Tools & Notifications\n' +
					'**Profile** - Lookup user | **Followers** - Toggle alerts | **Mentions** - Toggle alerts',
			),
		)
		.addActionRowComponents(toolsRow)
		.addSeparatorComponents()
		.addTextDisplayComponents(
			new TextDisplayBuilder().setContent(
				'> \u{26A0}\u{FE0F} Unofficial Instagram integration — use at your own risk',
			),
		);

	return {
		components: [container.toJSON()],
	};
};

// --- Modals ---

const buildSearchModal = (): ModalBuilder => {
	const queryInput = new TextInputBuilder()
		.setCustomId('query')
		.setLabel('Query (username or title)')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setMaxLength(100)
		.setPlaceholder('Enter username or thread title');
	const limitInput = new TextInputBuilder()
		.setCustomId('limit')
		.setLabel('Limit (1-50, optional)')
		.setRequired(false)
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('20');

	return new ModalBuilder()
		.setCustomId('ig:modal:search')
		.setTitle('IG Search')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(queryInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(limitInput),
		);
};

const buildUnsendModal = (): ModalBuilder => {
	const threadInput = new TextInputBuilder()
		.setCustomId('thread')
		.setLabel('Thread ID / username / title')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('e.g. john_doe or 1234567890');

	const messageIdInput = new TextInputBuilder()
		.setCustomId('message_id')
		.setLabel('Message ID to delete')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('Paste the message ID');

	return new ModalBuilder()
		.setCustomId('ig:modal:unsend')
		.setTitle('IG Unsend')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(threadInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(messageIdInput),
		);
};

const buildProfileModal = (): ModalBuilder => {
	const usernameInput = new TextInputBuilder()
		.setCustomId('username')
		.setLabel('Instagram username')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setMaxLength(80)
		.setPlaceholder('Enter username to lookup');

	return new ModalBuilder()
		.setCustomId('ig:modal:profile')
		.setTitle('IG Profile Lookup')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(usernameInput),
		);
};

// --- Slash command definition ---

export const igCommand = new SlashCommandBuilder()
	.setName('ig')
	.setDescription('Instagram actions')
	.addSubcommandGroup(group =>
		group
			.setName('account')
			.setDescription('Manage saved Instagram accounts')
			.addSubcommand(subcommand =>
				subcommand
					.setName('list')
					.setDescription('List saved session accounts'),
			)
			.addSubcommand(subcommand =>
				subcommand
					.setName('current')
					.setDescription('Show current active account'),
			)
			.addSubcommand(subcommand =>
				subcommand
					.setName('use')
					.setDescription('Switch active account')
					.addStringOption(option =>
						option
							.setName('username')
							.setDescription('Account username to activate')
							.setRequired(true),
					),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('panel')
			.setDescription('Open interactive IG panel (buttons + forms)'),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('inbox')
			.setDescription('List inbox threads')
			.addIntegerOption(option =>
				option
					.setName('limit')
					.setDescription('Maximum number of threads to return')
					.setMinValue(1)
					.setMaxValue(50),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('search')
			.setDescription('Search inbox threads')
			.addStringOption(option =>
				option
					.setName('query')
					.setDescription('Thread title or username query')
					.setRequired(true),
			)
			.addIntegerOption(option =>
				option
					.setName('limit')
					.setDescription('Maximum results')
					.setMinValue(1)
					.setMaxValue(50),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('send')
			.setDescription('Send a DM to a thread/user')
			.addStringOption(option =>
				option
					.setName('thread')
					.setDescription('Thread ID, username, or thread title')
					.setRequired(true),
			)
			.addStringOption(option =>
				option.setName('text').setDescription('Message text').setRequired(true),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('reply')
			.setDescription('Reply to a specific message in a thread')
			.addStringOption(option =>
				option
					.setName('thread')
					.setDescription('Thread ID, username, or thread title')
					.setRequired(true),
			)
			.addStringOption(option =>
				option
					.setName('message_id')
					.setDescription('Message ID to reply to')
					.setRequired(true),
			)
			.addStringOption(option =>
				option
					.setName('text')
					.setDescription('Reply message text')
					.setRequired(true),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('profile')
			.setDescription('View Instagram profile info')
			.addStringOption(option =>
				option
					.setName('username')
					.setDescription('Instagram username to lookup')
					.setRequired(true),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('unsend')
			.setDescription('Delete/unsend a previously sent message')
			.addStringOption(option =>
				option
					.setName('thread')
					.setDescription('Thread ID, username, or thread title')
					.setRequired(true),
			)
			.addStringOption(option =>
				option
					.setName('message_id')
					.setDescription('Message ID to delete')
					.setRequired(true),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('unread')
			.setDescription('Check for unread messages and new chats')
			.addIntegerOption(option =>
				option
					.setName('limit')
					.setDescription('Maximum threads to show')
					.setMinValue(1)
					.setMaxValue(50),
			),
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('notifications')
			.setDescription('Toggle notification settings')
			.addStringOption(option =>
				option
					.setName('type')
					.setDescription('Notification type to toggle')
					.setRequired(true)
					.addChoices(
						{name: 'Followers', value: 'followers'},
						{name: 'Mentions', value: 'mentions'},
					),
			),
	);

// --- Time formatting helper ---

function getTimeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return 'Just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return date.toLocaleDateString();
}

// --- Command handlers ---

export async function handleIgCommand(
	interaction: ChatInputCommandInteraction,
	context: IgCommandContext,
): Promise<void> {
	await interaction.deferReply({ephemeral: true});

	const group = interaction.options.getSubcommandGroup(false);
	const subcommand = interaction.options.getSubcommand();

	if (group === 'account') {
		if (subcommand === 'list') {
			const accounts = await context.accountManager.listAvailableAccounts();
			const current = await context.accountManager.getCurrentAccount();
			if (accounts.length === 0) {
				await interaction.editReply({
					embeds: [
						buildErrorEmbed(
							'No saved accounts found. Run `npm run auth:login` first.',
						),
					],
				});
				return;
			}

			await interaction.editReply({
				embeds: [buildAccountListEmbed(accounts, current)],
			});
			return;
		}

		if (subcommand === 'current') {
			const current = await context.accountManager.getCurrentAccount();
			await interaction.editReply({
				embeds: [
					current
						? buildSuccessEmbed(
								'Current Account',
								`Active account: **${current}**`,
								current,
							)
						: buildErrorEmbed(
								'No current account set. Use `/ig account use <username>`.',
							),
				],
			});
			return;
		}

		if (subcommand === 'use') {
			const username = interaction.options.getString('username', true).trim();
			await context.accountManager.useAccount(username);
			await interaction.editReply({
				embeds: [
					buildSuccessEmbed(
						'Account Switched',
						`Active account is now **@${username}**`,
						username,
					),
				],
			});
		}

		return;
	}

	if (subcommand === 'panel') {
		const panel = renderPanel();
		await interaction.editReply({
			content: panel.content,
			components: panel.components,
		});
		return;
	}

	const {account, client} = await resolveClient(context);

	if (subcommand === 'inbox') {
		const limit = interaction.options.getInteger('limit') ?? 20;
		const {threads} = await client.getThreads();
		const {embeds, components} = buildInboxEmbed(threads, limit, account);
		await interaction.editReply({embeds, components});
		return;
	}

	if (subcommand === 'search') {
		const query = interaction.options.getString('query', true);
		const limit = interaction.options.getInteger('limit') ?? 20;
		const [usernameResults, titleResults] = await Promise.all([
			client.searchThreadByUsername(query).catch(() => []),
			client.searchThreadsByTitle(query, {maxThreadsToSearch: limit * 4}),
		]);

		const seen = new Set<string>();
		const merged = [...usernameResults, ...titleResults].filter(result => {
			if (seen.has(result.thread.id)) {
				return false;
			}

			seen.add(result.thread.id);
			return true;
		});
		merged.sort((left, right) => right.score - left.score);
		const results = merged.slice(0, limit);

		const {embeds, components} = buildSearchEmbed(
			results,
			query,
			limit,
			account,
		);
		await interaction.editReply({embeds, components});
		return;
	}

	if (subcommand === 'send') {
		const threadQuery = interaction.options.getString('thread', true);
		const text = interaction.options.getString('text', true);
		const result = await executeSend(
			context,
			account,
			client,
			threadQuery,
			text,
			interaction.channelId,
		);
		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Message Sent',
					`Your message has been delivered successfully.\n\n\u{1F4E9} **Thread ID:** \`${result.threadId}\`\n\u{1F4CE} **Message ID:** \`${result.messageId}\``,
					account,
				),
			],
		});
		return;
	}

	if (subcommand === 'reply') {
		const threadQuery = interaction.options.getString('thread', true);
		const messageId = interaction.options.getString('message_id', true);
		const text = interaction.options.getString('text', true);
		const result = await executeReply(
			context,
			account,
			client,
			threadQuery,
			messageId,
			text,
			interaction.channelId,
		);
		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Reply Sent',
					`Your reply has been sent successfully.\n\n\u{1F4E9} **Thread ID:** \`${result.threadId}\`\n\u{1F4CE} **Message ID:** \`${result.messageId}\`\n\u{21A9}\u{FE0F} **Replying to:** ${result.replyToUsername ?? 'Unknown'}`,
					account,
				),
			],
		});
		return;
	}

	if (subcommand === 'profile') {
		const username = interaction.options.getString('username', true).trim();
		const profile = await withRetry(async () =>
			client.getUserProfile(username),
		);

		if (!profile) {
			await interaction.editReply({
				embeds: [buildErrorEmbed(`User @${username} not found.`)],
			});
			return;
		}

		await interaction.editReply({
			embeds: [buildProfileEmbed(profile, account)],
		});
		return;
	}

	if (subcommand === 'unsend') {
		const threadQuery = interaction.options.getString('thread', true);
		const messageId = interaction.options.getString('message_id', true);
		const {threadId} = await resolveThread(client, threadQuery);

		await context.queue.enqueue(`unsend:${account}:${threadId}`, async () => {
			await context.rateLimiter.take(`unsend:${account}`);
			return withRetry(async () => client.unsendMessage(threadId, messageId));
		});

		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Message Deleted',
					`Message \`${messageId}\` has been deleted from thread \`${threadId}\`.`,
					account,
				),
			],
		});
		return;
	}

	if (subcommand === 'unread') {
		const limit = interaction.options.getInteger('limit') ?? 20;
		const {threads} = await client.getThreads();

		const unreadThreads = threads
			.filter(t => t.unread)
			.slice(0, limit)
			.map(t => {
				const lastMsg =
					t.lastMessage && 'text' in t.lastMessage
						? t.lastMessage.text
						: t.lastMessage
							? '[non-text message]'
							: 'No messages yet';
				return {
					title: t.title,
					lastMessage: lastMsg,
					lastActivity: t.lastActivity,
					id: t.id,
				};
			});

		await interaction.editReply({
			embeds: [buildUnreadEmbed(unreadThreads, threads.length, account)],
		});
		return;
	}

	if (subcommand === 'notifications') {
		const notifType = interaction.options.getString('type', true) as
			| 'followers'
			| 'mentions';

		// Use the poller's toggle method (accessed via context)
		const isEnabled = context.notificationPoller.toggleSetting(
			account,
			notifType,
		);

		const emoji = notifType === 'followers' ? '\u{1F465}' : '\u{1F4DB}';
		const status = isEnabled ? 'enabled' : 'disabled';

		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Notification Updated',
					`${emoji} **${notifType}** notifications are now **${status}**.`,
					account,
				),
			],
		});
	}
}

export async function handleIgButton(
	interaction: ButtonInteraction,
	context: IgCommandContext,
): Promise<boolean> {
	const action = parseInteractiveId(interaction.customId, 'btn');
	if (!action) {
		return false;
	}

	// Defer immediately for any action that will do async work
	if (action === 'inbox') {
		await interaction.deferReply({ephemeral: true});
		const {account, client} = await resolveClient(context);
		const {threads} = await client.getThreads();
		const {embeds, components} = buildInboxEmbed(threads, 20, account);
		await interaction.editReply({embeds, components});
		return true;
	}

	// showModal is instant, no defer needed
	if (action === 'search') {
		await interaction.showModal(buildSearchModal());
		return true;
	}

	if (action === 'send') {
		await interaction.showModal(buildSendModal());
		return true;
	}

	if (action === 'reply') {
		await interaction.showModal(buildReplyModal());
		return true;
	}

	if (action === 'unsend') {
		await interaction.showModal(buildUnsendModal());
		return true;
	}

	if (action === 'unread') {
		await interaction.deferReply({ephemeral: true});
		const {account, client} = await resolveClient(context);
		const {threads} = await client.getThreads();

		const unreadThreads = threads
			.filter(t => t.unread)
			.slice(0, 20)
			.map(t => {
				const lastMsg =
					t.lastMessage && 'text' in t.lastMessage
						? t.lastMessage.text
						: t.lastMessage
							? '[non-text message]'
							: 'No messages yet';
				return {
					title: t.title,
					lastMessage: lastMsg,
					lastActivity: t.lastActivity,
					id: t.id,
				};
			});

		await interaction.editReply({
			embeds: [buildUnreadEmbed(unreadThreads, threads.length, account)],
		});
		return true;
	}

	if (action === 'profile') {
		await interaction.showModal(buildProfileModal());
		return true;
	}

	// Notification toggle buttons
	if (action === 'notif-followers') {
		await interaction.deferReply({ephemeral: true});
		const {account} = await resolveClient(context);
		const enabled = context.notificationPoller.toggleSetting(
			account,
			'followers',
		);
		const status = enabled ? 'enabled' : 'disabled';
		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Follower Alerts',
					`\u{1F465} Follower notifications are now **${status}**.`,
					account,
				),
			],
		});
		return true;
	}

	if (action === 'notif-mentions') {
		await interaction.deferReply({ephemeral: true});
		const {account} = await resolveClient(context);
		const enabled = context.notificationPoller.toggleSetting(
			account,
			'mentions',
		);
		const status = enabled ? 'enabled' : 'disabled';
		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Mention Alerts',
					`\u{1F4DB} Mention notifications are now **${status}**.`,
					account,
				),
			],
		});
		return true;
	}

	return false;
}

/**
 * Handles StringSelectMenu interactions from inbox/search embeds.
 * Opens a send modal pre-filled with the selected thread ID.
 */
export async function handleIgSelectMenu(
	interaction: StringSelectMenuInteraction,
	_context: IgCommandContext,
): Promise<boolean> {
	const action = parseInteractiveId(interaction.customId, 'select');
	if (!action) {
		return false;
	}

	if (action === 'thread') {
		const selectedValue = interaction.values[0];
		if (!selectedValue) return false;

		// Extract thread ID from value format: "thread_{id}"
		const threadId = selectedValue.replace('thread_', '');
		if (!threadId) return false;

		// Open a send modal pre-filled with the thread ID
		await interaction.showModal(buildSendModal(threadId));
		return true;
	}

	return false;
}

export async function handleIgModal(
	interaction: ModalSubmitInteraction,
	context: IgCommandContext,
): Promise<boolean> {
	const action = parseInteractiveId(interaction.customId, 'modal');
	if (!action) {
		return false;
	}

	await interaction.deferReply({ephemeral: true});

	const {account, client} = await resolveClient(context);
	const {channelId} = interaction;
	if (!channelId) {
		throw new Error('This action requires a Discord channel context.');
	}

	if (action === 'search') {
		const query = interaction.fields.getTextInputValue('query').trim();
		const limit = normalizeLimit(
			interaction.fields.getTextInputValue('limit').trim(),
			20,
		);
		const [usernameResults, titleResults] = await Promise.all([
			client.searchThreadByUsername(query).catch(() => []),
			client.searchThreadsByTitle(query, {maxThreadsToSearch: limit * 4}),
		]);

		const seen = new Set<string>();
		const merged = [...usernameResults, ...titleResults].filter(result => {
			if (seen.has(result.thread.id)) {
				return false;
			}

			seen.add(result.thread.id);
			return true;
		});
		merged.sort((left, right) => right.score - left.score);
		const results = merged.slice(0, limit);

		const {embeds, components} = buildSearchEmbed(
			results,
			query,
			limit,
			account,
		);
		await interaction.editReply({embeds, components});
		return true;
	}

	if (action === 'send') {
		const threadQuery = interaction.fields.getTextInputValue('thread').trim();
		const text = interaction.fields.getTextInputValue('text').trim();
		const result = await executeSend(
			context,
			account,
			client,
			threadQuery,
			text,
			channelId,
		);
		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Message Sent',
					`Your message has been delivered successfully.\n\n\u{1F4E9} **Thread ID:** \`${result.threadId}\`\n\u{1F4CE} **Message ID:** \`${result.messageId}\``,
					account,
				),
			],
		});
		return true;
	}

	if (action === 'reply') {
		const threadQuery = interaction.fields.getTextInputValue('thread').trim();
		const messageId = interaction.fields.getTextInputValue('message_id').trim();
		const text = interaction.fields.getTextInputValue('text').trim();
		const result = await executeReply(
			context,
			account,
			client,
			threadQuery,
			messageId,
			text,
			channelId,
		);
		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Reply Sent',
					`Your reply has been sent successfully.\n\n\u{1F4E9} **Thread ID:** \`${result.threadId}\`\n\u{1F4CE} **Message ID:** \`${result.messageId}\`\n\u{21A9}\u{FE0F} **Replying to:** ${result.replyToUsername ?? 'Unknown'}`,
					account,
				),
			],
		});
		return true;
	}

	if (action === 'unsend') {
		const threadQuery = interaction.fields.getTextInputValue('thread').trim();
		const messageId = interaction.fields.getTextInputValue('message_id').trim();
		const {threadId} = await resolveThread(client, threadQuery);

		await context.queue.enqueue(`unsend:${account}:${threadId}`, async () => {
			await context.rateLimiter.take(`unsend:${account}`);
			return withRetry(async () => client.unsendMessage(threadId, messageId));
		});

		await interaction.editReply({
			embeds: [
				buildSuccessEmbed(
					'Message Deleted',
					`Message \`${messageId}\` has been deleted from thread \`${threadId}\`.`,
					account,
				),
			],
		});
		return true;
	}

	if (action === 'profile') {
		const username = interaction.fields.getTextInputValue('username').trim();
		const profile = await withRetry(async () =>
			client.getUserProfile(username),
		);

		if (!profile) {
			await interaction.editReply({
				embeds: [buildErrorEmbed(`User @${username} not found.`)],
			});
			return true;
		}

		await interaction.editReply({
			embeds: [buildProfileEmbed(profile, account)],
		});
		return true;
	}

	await interaction.editReply({
		embeds: [buildErrorEmbed('Unsupported modal action.')],
	});
	return true;
}
