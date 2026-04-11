import {
	ActionRowBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from 'discord.js';

export const buildSendModal = (prefillThread?: string): ModalBuilder => {
	const threadInput = new TextInputBuilder()
		.setCustomId('thread')
		.setLabel('Thread ID / username / title')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('e.g. john_doe or 1234567890');
	if (prefillThread) {
		threadInput.setValue(prefillThread.slice(0, 4000));
	}

	const textInput = new TextInputBuilder()
		.setCustomId('text')
		.setLabel('Message text')
		.setRequired(true)
		.setStyle(TextInputStyle.Paragraph)
		.setMaxLength(1800)
		.setPlaceholder('Type your message here...');

	return new ModalBuilder()
		.setCustomId('ig:modal:send')
		.setTitle('IG Send')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(threadInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
		);
};

export const buildReplyModal = (
	prefillThread?: string,
	prefillMessageId?: string,
): ModalBuilder => {
	const threadInput = new TextInputBuilder()
		.setCustomId('thread')
		.setLabel('Thread ID / username / title')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('e.g. john_doe or 1234567890');
	if (prefillThread) {
		threadInput.setValue(prefillThread.slice(0, 4000));
	}

	const messageIdInput = new TextInputBuilder()
		.setCustomId('message_id')
		.setLabel('Reply-to message ID')
		.setRequired(true)
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('Paste the message ID');
	if (prefillMessageId) {
		messageIdInput.setValue(prefillMessageId.slice(0, 4000));
	}

	const textInput = new TextInputBuilder()
		.setCustomId('text')
		.setLabel('Reply text')
		.setRequired(true)
		.setStyle(TextInputStyle.Paragraph)
		.setMaxLength(1800)
		.setPlaceholder('Type your reply here...');

	return new ModalBuilder()
		.setCustomId('ig:modal:reply')
		.setTitle('IG Reply')
		.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(threadInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(messageIdInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
		);
};
