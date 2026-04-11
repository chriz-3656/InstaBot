#!/usr/bin/env node
import process from 'node:process';
import dotenv from 'dotenv';
import {initializeLogger, createContextualLogger} from './utils/logger.js';
import {startDiscordBot} from './discord/bot.js';

const logger = createContextualLogger('Bootstrap');
dotenv.config();

await initializeLogger();

const runtime = await startDiscordBot();

const shutdown = async (signal: string) => {
	logger.info(`Received ${signal}. Shutting down.`);
	await runtime.shutdown();
	process.exit(0);
};

process.once('SIGINT', () => {
	void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
	void shutdown('SIGTERM');
});
