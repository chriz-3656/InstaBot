import process from 'node:process';
import {Client, GatewayIntentBits} from 'discord.js';
import {createContextualLogger} from '../utils/logger.js';
import {installCommandRouter, slashCommands} from './command-router.js';
import {type DiscordBotConfig} from './types.js';

const logger = createContextualLogger('DiscordBot');

function ensureConfig(): DiscordBotConfig {
	const token = process.env['DISCORD_BOT_TOKEN'];
	const clientId = process.env['DISCORD_CLIENT_ID'];
	const guildId = process.env['DISCORD_GUILD_ID'];

	if (!token) {
		throw new Error('Missing DISCORD_BOT_TOKEN');
	}

	if (!clientId) {
		throw new Error('Missing DISCORD_CLIENT_ID');
	}

	return {token, clientId, guildId};
}

async function registerSlashCommands(
	client: Client,
	config: DiscordBotConfig,
): Promise<void> {
	if (!client.application) {
		throw new Error('Discord application is not ready');
	}

	const commandPayload = slashCommands.map(command => command.toJSON());

	if (config.guildId) {
		const guild = await client.guilds.fetch(config.guildId);
		await guild.commands.set(commandPayload);
		logger.info(`Registered slash commands for guild ${config.guildId}`);
		return;
	}

	await client.application.commands.set(commandPayload);
	logger.info('Registered global slash commands');
}

export async function startDiscordBot(): Promise<{
	shutdown: () => Promise<void>;
}> {
	const config = ensureConfig();
	const client = new Client({
		intents: [GatewayIntentBits.Guilds],
	});

	const {accountManager} = installCommandRouter(client);

	client.once('ready', () => {
		logger.info(`Discord bot connected as ${client.user?.tag ?? 'unknown'}`);
		void registerSlashCommands(client, config);
	});

	await client.login(config.token);

	return {
		async shutdown() {
			await accountManager.shutdown();
			await client.destroy();
		},
	};
}
