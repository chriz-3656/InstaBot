import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ModalBuilder,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type ModalSubmitInteraction,
} from 'discord.js';
import {type DmRelay} from '../../bridge/dm-relay.js';
import {
	resolveThread,
	type InstagramClient,
} from '../../core/instagram/index.js';
import {type AsyncQueue} from '../../safety/queue.js';
import {type RateLimiter} from '../../safety/rate-limiter.js';
import {withRetry} from '../../safety/retry.js';
import {type DiscordAccountManager} from '../account-manager.js';

type InboxThread = Awaited<
	ReturnType<InstagramClient['getThreads']>
>['threads'][number];

export type IgCommandContext = {
	accountManager: DiscordAccountManager;
	dmRelay: DmRelay;
	rateLimiter: RateLimiter;
	queue: AsyncQueue;
	ensureRelayAttached: (
		account: string,
		client: InstagramClient,
	) => Promise<void>;
};

const RISK_WARNING =
	'Warning: Unofficial Instagram integration. Use temporary/demo accounts. Use at your own risk.';

const formatInboxLine = (thread: InboxThread): string => {
	const unreadTag = thread.unread ? ' [UNREAD]' : '';
	const preview =
		thread.lastMessage && 'text' in thread.lastMessage
			? ` - ${thread.lastMessage.text}`
			: '';
	return `${thread.title}${unreadTag}${preview} (id: ${thread.id})`;
};

const normalizeLimit = (value: string | undefined, fallback = 20): number => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.min(50, Math.max(1, Math.floor(parsed)));
};

const parseInteractiveId = (
	customId: string,
	expectedKind: 'btn' | 'modal',
): string | undefined => {
	const parts = customId.split(':');
	if (parts.length !== 3 || parts[0] !== 'ig' || parts[1] !== expectedKind) {
		return undefined;
	}

	return parts[2];
};

const resolveClient = async (
	context: IgCommandContext,
): Promise<{account: string; client: InstagramClient}> => {
	const {account, client} = await context.accountManager.getClient();
	await context.ensureRelayAttached(account, client);
	return {account, client};
};

const executeInbox = async (
	client: InstagramClient,
	limit = 20,
): Promise<string> => {
	const {threads} = await client.getThreads();
	const lines = threads.slice(0, limit).map(thread => formatInboxLine(thread));
	return lines.length > 0 ? lines.join('\n') : 'No threads found.';
};

const executeSearch = async (
	client: InstagramClient,
	query: string,
	limit = 20,
): Promise<string> => {
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
	const lines = merged
		.slice(0, limit)
		.map(
			result =>
				`${result.thread.title} (${Math.round(result.score * 100)}%) [${result.thread.id}]`,
		);
	return lines.length > 0
		? lines.join('\n')
		: `No threads matching "${query}".`;
};

const executeSend = async (
	context: IgCommandContext,
	account: string,
	client: InstagramClient,
	threadQuery: string,
	text: string,
	channelId: string,
): Promise<string> => {
	const {threadId} = await resolveThread(client, threadQuery);
	await context.dmRelay.mapThreadToChannel(account, threadId, channelId);

	const queueKey = `send:${account}:${threadId}`;
	const rateKey = `send:${account}`;
	const messageId = await context.queue.enqueue(queueKey, async () => {
		await context.rateLimiter.take(rateKey);
		return withRetry(async () => client.sendMessage(threadId, text));
	});

	return `Sent message to thread ${threadId}. message_id=${messageId}`;
};

const executeReply = async (
	context: IgCommandContext,
	account: string,
	client: InstagramClient,
	threadQuery: string,
	replyToMessageId: string,
	text: string,
	channelId: string,
): Promise<string> => {
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

	return `Reply sent in thread ${threadId}. message_id=${replyMessageId}`;
};

const renderPanel = (): {
	content: string;
	components: Array<ActionRowBuilder<ButtonBuilder>>;
} => {
	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId('ig:btn:inbox')
			.setLabel('Inbox')
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId('ig:btn:search')
			.setLabel('Search')
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId('ig:btn:send')
			.setLabel('Send')
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId('ig:btn:reply')
			.setLabel('Reply')
			.setStyle(ButtonStyle.Secondary),
	);

	return {
		content: `${RISK_WARNING}\n\nInstagram panel`,
		components: [row],
	};
};

const buildSearchModal = (): ModalBuilder => {
	const queryInput = new TextInputBuilder()
		.setCustomId('query')
		.setLabel('Query (username or title)')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setMaxLength(100);
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

const buildSendModal = (): ModalBuilder => {
	const threadInput = new TextInputBuilder()
		.setCustomId('thread')
		.setLabel('Thread ID / username / title')
		.setRequired(true)
		.setStyle(TextInputStyle.Short);
	const textInput = new TextInputBuilder()
		.setCustomId('text')
		.setLabel('Message text')
		.setRequired(true)
		.setStyle(TextInputStyle.Paragraph)
		.setMaxLength(1800);

	return new ModalBuilder()
		.setCustomId('ig:modal:send')
		.setTitle('IG Send')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(threadInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
		);
};

const buildReplyModal = (): ModalBuilder => {
	const threadInput = new TextInputBuilder()
		.setCustomId('thread')
		.setLabel('Thread ID / username / title')
		.setRequired(true)
		.setStyle(TextInputStyle.Short);
	const messageIdInput = new TextInputBuilder()
		.setCustomId('message_id')
		.setLabel('Reply-to message ID')
		.setRequired(true)
		.setStyle(TextInputStyle.Short);
	const textInput = new TextInputBuilder()
		.setCustomId('text')
		.setLabel('Reply text')
		.setRequired(true)
		.setStyle(TextInputStyle.Paragraph)
		.setMaxLength(1800);

	return new ModalBuilder()
		.setCustomId('ig:modal:reply')
		.setTitle('IG Reply')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(threadInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(messageIdInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
		);
};

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
	);

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
					content: `${RISK_WARNING}\n\nNo saved accounts found. Run \`npm run auth:login\` first.`,
				});
				return;
			}

			const lines = accounts.map(account =>
				account === current ? `• ${account} (current)` : `• ${account}`,
			);
			await interaction.editReply({
				content: `${RISK_WARNING}\n\nSaved accounts:\n${lines.join('\n')}`,
			});
			return;
		}

		if (subcommand === 'current') {
			const current = await context.accountManager.getCurrentAccount();
			await interaction.editReply({
				content: current
					? `${RISK_WARNING}\n\nCurrent account: ${current}`
					: `${RISK_WARNING}\n\nNo current account set. Use \`/ig account use <username>\`.`,
			});
			return;
		}

		if (subcommand === 'use') {
			const username = interaction.options.getString('username', true).trim();
			await context.accountManager.useAccount(username);
			await interaction.editReply({
				content: `${RISK_WARNING}\n\nActive account switched to: ${username}`,
			});
		}

		return;
	}

	if (subcommand === 'panel') {
		await interaction.editReply(renderPanel());
		return;
	}

	const {account, client} = await resolveClient(context);

	if (subcommand === 'inbox') {
		const limit = interaction.options.getInteger('limit') ?? 20;
		const payload = await executeInbox(client, limit);
		await interaction.editReply({
			content: `${RISK_WARNING}\n\n${payload}`.slice(0, 1900),
		});
		return;
	}

	if (subcommand === 'search') {
		const query = interaction.options.getString('query', true);
		const limit = interaction.options.getInteger('limit') ?? 20;
		const payload = await executeSearch(client, query, limit);
		await interaction.editReply({
			content: `${RISK_WARNING}\n\n${payload}`.slice(0, 1900),
		});
		return;
	}

	if (subcommand === 'send') {
		const threadQuery = interaction.options.getString('thread', true);
		const text = interaction.options.getString('text', true);
		const payload = await executeSend(
			context,
			account,
			client,
			threadQuery,
			text,
			interaction.channelId,
		);
		await interaction.editReply({content: `${RISK_WARNING}\n\n${payload}`});
		return;
	}

	if (subcommand === 'reply') {
		const threadQuery = interaction.options.getString('thread', true);
		const messageId = interaction.options.getString('message_id', true);
		const text = interaction.options.getString('text', true);
		const payload = await executeReply(
			context,
			account,
			client,
			threadQuery,
			messageId,
			text,
			interaction.channelId,
		);
		await interaction.editReply({content: `${RISK_WARNING}\n\n${payload}`});
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

	if (action === 'inbox') {
		await interaction.deferReply({ephemeral: true});
		const {client} = await resolveClient(context);
		const payload = await executeInbox(client, 20);
		await interaction.editReply({
			content: `${RISK_WARNING}\n\n${payload}`.slice(0, 1900),
		});
		return true;
	}

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
		const payload = await executeSearch(client, query, limit);
		await interaction.editReply({
			content: `${RISK_WARNING}\n\n${payload}`.slice(0, 1900),
		});
		return true;
	}

	if (action === 'send') {
		const threadQuery = interaction.fields.getTextInputValue('thread').trim();
		const text = interaction.fields.getTextInputValue('text').trim();
		const payload = await executeSend(
			context,
			account,
			client,
			threadQuery,
			text,
			channelId,
		);
		await interaction.editReply({content: `${RISK_WARNING}\n\n${payload}`});
		return true;
	}

	if (action === 'reply') {
		const threadQuery = interaction.fields.getTextInputValue('thread').trim();
		const messageId = interaction.fields.getTextInputValue('message_id').trim();
		const text = interaction.fields.getTextInputValue('text').trim();
		const payload = await executeReply(
			context,
			account,
			client,
			threadQuery,
			messageId,
			text,
			channelId,
		);
		await interaction.editReply({content: `${RISK_WARNING}\n\n${payload}`});
		return true;
	}

	await interaction.editReply({content: 'Unsupported modal action.'});
	return true;
}
