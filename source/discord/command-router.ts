import {type Client, type Interaction} from 'discord.js';
import {DmRelay} from '../bridge/dm-relay.js';
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
} from './commands/ig.js';

const logger = createContextualLogger('DiscordCommandRouter');

export const slashCommands = [igCommand];

export function installCommandRouter(discordClient: Client): {
	accountManager: DiscordAccountManager;
} {
	const accountManager = new DiscordAccountManager();
	const dmRelay = new DmRelay();
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
	};

	discordClient.on('interactionCreate', async (interaction: Interaction) => {
		const context = {
			accountManager,
			dmRelay,
			rateLimiter,
			queue,
			ensureRelayAttached,
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
			}
		} catch (error) {
			logger.error('Interaction failed', error);
			const content = `Command failed: ${
				error instanceof Error ? error.message : String(error)
			}`;

			if (!interaction.isRepliable()) {
				return;
			}

			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({content});
				return;
			}

			await interaction.reply({content, ephemeral: true});
		}
	});

	return {accountManager};
}
