/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import test from 'ava';
import {MessageSyncMessageTypes} from 'instagram_mqtt';
import {
	parseMessageItem,
	getBestMediaUrl,
} from '../source/utils/message-parser.js';
import type {MessageMedia, TextMessage} from '../source/types/instagram.js';

const mockContext = {
	userCache: new Map<string, string>(),
	currentUserId: '1001',
};

test('parseMessageItem parses standard text message', t => {
	const rawMessage = {
		item_id: 'msg_123',
		user_id: 1002,
		timestamp: String(Date.now() * 1000),
		item_type: MessageSyncMessageTypes.Text,
		text: 'Hello world',
	};

	const result = parseMessageItem(rawMessage as any, 'thread_1', mockContext);
	t.truthy(result);
	t.is(result?.id, 'msg_123');
	t.is(result?.itemType, 'text');
	t.is((result as TextMessage)?.text, 'Hello world');
});

test('getBestMediaUrl picks highest quality image', t => {
	const media: MessageMedia = {
		id: 'media_2',
		media_type: 1,
		original_width: 1080,
		original_height: 1080,
		image_versions2: {
			candidates: [
				{url: 'low.jpg', width: 320, height: 240},
				{url: 'high.jpg', width: 1080, height: 1080},
			],
		},
	} as unknown as MessageMedia;

	const best = getBestMediaUrl(media);
	t.is(best?.url, 'high.jpg');
});
