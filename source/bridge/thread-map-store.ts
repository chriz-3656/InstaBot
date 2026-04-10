import fs from 'node:fs/promises';
import path from 'node:path';
import {ConfigManager} from '../core/instagram/index.js';

type ThreadMap = Record<string, string>;
type MapFile = Record<string, ThreadMap>;

export class ThreadMapStore {
	private readonly config = ConfigManager.getInstance();
	private filePath: string | undefined;

	public async initialize(): Promise<void> {
		await this.config.initialize();
		const dataDir = this.config.get('advanced.dataDir');
		await fs.mkdir(dataDir, {recursive: true});
		this.filePath = path.join(dataDir, 'discord-thread-map.json');
	}

	public async getChannelId(
		account: string,
		threadId: string,
	): Promise<string | undefined> {
		const map = await this.readMap();
		return map[account]?.[threadId];
	}

	public async setChannelId(
		account: string,
		threadId: string,
		channelId: string,
	): Promise<void> {
		const map = await this.readMap();
		map[account] ??= {};
		map[account][threadId] = channelId;
		await this.writeMap(map);
	}

	private async getFilePath(): Promise<string> {
		if (!this.filePath) {
			await this.initialize();
		}

		if (!this.filePath) {
			throw new Error('Thread map store is not initialized');
		}

		return this.filePath;
	}

	private async readMap(): Promise<MapFile> {
		try {
			const raw = await fs.readFile(await this.getFilePath(), 'utf8');
			return JSON.parse(raw) as MapFile;
		} catch {
			return {};
		}
	}

	private async writeMap(map: MapFile): Promise<void> {
		await fs.writeFile(
			await this.getFilePath(),
			JSON.stringify(map, null, 2),
			'utf8',
		);
	}
}
