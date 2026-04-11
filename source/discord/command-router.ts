import {
	EmbedBuilder,
	type Client,
	type Interaction,
	type InteractionEditReplyOptions,
	type InteractionReplyOptions,
} from 'discord.js';
import {DmRelay} from '../bridge/dm-relay.js';
import {NotificationPoller} from '../bridge/notification-poller.js';
import {type InstagramClient} from '../core/instagram/index.js';
import {RateLimiter} from '../safety/rate-limiter.js';
import {AsyncQueue} from '../safety/queue.js';
import {createContextualLogger} from '../utils/logger.js';
import {DiscordAccountManager} from './account-manager.js';
import {
	igCommand,
	handleIgButton,
	handleIgCommand,
	handleIgModal,
	handleIgSelectMenu,
} from './commands/ig.js';

const logger = createContextualLogger('DiscordCommandRouter');

export const slashCommands = [igCommand];

const ERROR_COLOR = 0xed_42_45; // Discord red

function buildErrorEmbed(message: string): {embeds: EmbedBuilder[]} {
	return {
		embeds: [
			new EmbedBuilder()
				.setColor(ERROR_COLOR)
				.setTitle('Command Failed')
				.setDescription(message)
				.setTimestamp(),
		],
	};
}

/**
 * Safely replies to an interaction, handling all edge cases:
 * - Already deferred
 * - Already replied
 * - Not repliable
 * - Expired interaction
 */
async function safeReply(
	interaction: Interaction,
	options: InteractionReplyOptions,
): Promise<void> {
	if (!interaction.isRepliable()) return;

	try {
		if (interaction.deferred || interaction.replied) {
			// editReply doesn't accept ephemeral flag, but deferred replies
			// already inherit the ephemeral setting from deferReply
			const editOptions: InteractionEditReplyOptions = {
				embeds: options.embeds,
				components: options.components,
				content: options.content,
				files: options.files,
			};
			await interaction.editReply(editOptions);
		} else {
			await interaction.reply(options);
		}
	} catch (error) {
		// Interaction may have expired, log but don't crash
		if ((error as {code?: number})?.code === 10_062) {
			logger.warn('Interaction expired, skipping reply');
		} else {
			logger.error('Failed to reply to interaction', error);
		}
	}
}

export function installCommandRouter(discordClient: Client): {
	accountManager: DiscordAccountManager;
	notificationPoller: NotificationPoller;
} {
	const accountManager = new DiscordAccountManager();
	const dmRelay = new DmRelay();
	const notificationPoller = new NotificationPoller();
	const rateLimiter = new RateLimiter(4, 1000);
	const queue = new AsyncQueue();
	const attachedRelayAccounts = new Set<string>();

	const ensureRelayAttached = async (
		account: string,
		client: InstagramClient,
	): Promise<void> => {
		if (attachedRelayAccounts.has(account)) {
			return;
		}

		await dmRelay.attachAccount(discordClient, account, client);
		attachedRelayAccounts.add(account);

		// Initialize notification state for this account
		await notificationPoller.initializeAccount(account, client);
	};

	// Start the notification poller once relay is attached
	const startNotifications = async (): Promise<void> => {
		const currentAccount = await accountManager.getCurrentAccount();
		if (!currentAccount) return;

		const client = await accountManager.getClientFor(currentAccount);
		if (!client) return;

		await notificationPoller.start(
			discordClient,
			(account: string) => {
				void account;
				return client;
			},
			async () => currentAccount,
		);
	};

	// Start after first relay attach
	const originalEnsureRelayAttached = ensureRelayAttached;
	let notificationsStarted = false;
	const wrappedEnsureRelayAttached = async (
		account: string,
		client: InstagramClient,
	): Promise<void> => {
		await originalEnsureRelayAttached(account, client);
		if (!notificationsStarted) {
			notificationsStarted = true;
			await startNotifications();
		}
	};

	discordClient.on('interactionCreate', async (interaction: Interaction) => {
		const context = {
			accountManager,
			dmRelay,
			notificationPoller,
			rateLimiter,
			queue,
			ensureRelayAttached: wrappedEnsureRelayAttached,
		};

		try {
			if (interaction.isChatInputCommand()) {
				if (interaction.commandName !== 'ig') {
					return;
				}

				await handleIgCommand(interaction, context);
				return;
			}

			if (interaction.isButton()) {
				await handleIgButton(interaction, context);
				return;
			}

			if (interaction.isModalSubmit()) {
				await handleIgModal(interaction, context);
				return;
			}

			if (interaction.isStringSelectMenu()) {
				await handleIgSelectMenu(interaction, context);
				return;
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error('Interaction failed', error);

			await safeReply(interaction, {
				...buildErrorEmbed(errorMessage),
				ephemeral: true,
			});
		}
	});

	return {accountManager, notificationPoller};
}
