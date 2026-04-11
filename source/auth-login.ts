#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';
import {InstagramClient} from './client.js';
import {getLogger, initializeLogger} from './utils/logger.js';

dotenv.config();

type PromptResult = {
	username: string;
	password: string;
};

async function promptCredentials(): Promise<PromptResult> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const defaultUsername = process.env['IG_DEFAULT_ACCOUNT'] ?? '';
		const usernameInput = await rl.question(
			defaultUsername
				? `Instagram username [${defaultUsername}]: `
				: 'Instagram username: ',
		);
		const username = (usernameInput.trim() || defaultUsername).trim();
		if (!username) {
			throw new Error('Username is required');
		}

		const passwordInput = await rl.question('Instagram password: ');
		const password = passwordInput.trim();
		if (!password) {
			throw new Error('Password is required');
		}

		return {username, password};
	} finally {
		rl.close();
	}
}

async function promptCode(label: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const codeInput = await rl.question(`${label}: `);
		const code = codeInput.trim();
		if (!code) {
			throw new Error('Verification code is required');
		}

		return code;
	} finally {
		rl.close();
	}
}

async function run(): Promise<void> {
	await initializeLogger();
	const {username, password} = await promptCredentials();
	const client = new InstagramClient();

	try {
		const loginResult = await client.login(username, password, {
			initializeRealtime: false,
		});

		if (loginResult.success) {
			process.stdout.write(`Session saved for @${username}\n`);
			return;
		}

		if (loginResult.twoFactorInfo) {
			const method = loginResult.twoFactorInfo.totp_two_factor_on
				? 'Authenticator app code'
				: 'SMS code';
			const code = await promptCode(`Enter ${method}`);
			const twoFactorResult = await client.twoFactorLogin({
				verificationCode: code,
				twoFactorIdentifier: loginResult.twoFactorInfo.two_factor_identifier,
				totp_two_factor_on: loginResult.twoFactorInfo.totp_two_factor_on,
			});
			if (twoFactorResult.success) {
				process.stdout.write(`Session saved for @${username}\n`);
				return;
			}

			throw new Error(twoFactorResult.error ?? '2FA login failed');
		}

		if (loginResult.checkpointError) {
			await client.startChallenge();
			const code = await promptCode('Enter challenge security code');
			const challengeResult = await client.sendChallengeCode(code);
			if (challengeResult.success) {
				process.stdout.write(`Session saved for @${username}\n`);
				return;
			}

			throw new Error(challengeResult.error ?? 'Challenge login failed');
		}

		throw new Error(
			loginResult.error ??
				(loginResult.badPassword
					? 'Incorrect username or password'
					: 'Login failed'),
		);
	} finally {
		await client.shutdown().catch(() => {});
	}
}

await run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	const logPath = getLogger().getLogFilePath();
	if (/aggregateerror/i.test(message)) {
		process.stderr.write(
			`Auth login failed: ${message}\n` +
				'Instagram request failed at network level.\n' +
				'Try:\n' +
				'1) Disable VPN/proxy and retry.\n' +
				'2) Retry on a different network (mobile hotspot).\n' +
				'3) Verify username/password.\n' +
				`4) Check logs: ${logPath}\n`,
		);
	} else {
		process.stderr.write(`Auth login failed: ${message}\n`);
		process.stderr.write(`Check logs: ${logPath}\n`);
	}

	process.exitCode = 1;
});
