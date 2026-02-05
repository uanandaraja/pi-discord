import {
	Client,
	GatewayIntentBits,
	Events,
	ChannelType,
	Partials,
	type TextChannel,
	type DMChannel,
	type Message,
} from "discord.js";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join, basename } from "path";
import chalk from "chalk";

// ============================================================================
// Types
// ============================================================================

export interface DiscordEvent {
	type: "mention" | "dm";
	channelId: string;
	messageId: string;
	userId: string;
	userName: string;
	displayName: string;
	text: string;
	attachments?: Array<{ name: string; url: string }>;
}

export interface DiscordUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface DiscordChannel {
	id: string;
	name: string;
	type: "dm" | "guild";
}

export interface DiscordContext {
	message: {
		text: string;
		rawText: string;
		userId: string;
		userName: string;
		displayName: string;
		channelId: string;
		messageId: string;
		attachments: Array<{ url: string; name: string }>;
	};
	channelName?: string;
	isDM: boolean;
	guildName?: string;
	respond: (text: string) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface BotHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers the bot (ASYNC)
	 */
	handleEvent(event: DiscordEvent, bot: DiscordBot): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 */
	handleStop(channelId: string, bot: DiscordBot): Promise<void>;
}

// ============================================================================
// Logging helpers
// ============================================================================

function logInfo(message: string): void {
	console.log(chalk.blue("ℹ"), message);
}

function logWarning(message: string, detail?: string): void {
	console.log(chalk.yellow("⚠"), message, detail ? chalk.gray(`(${detail})`) : "");
}

function logConnected(): void {
	console.log(chalk.green("✓"), chalk.bold("Discord bot connected and listening!"));
}

function logStartup(workingDir: string): void {
	console.log(chalk.cyan("🤖 Pi Discord Bot"));
	console.log(chalk.gray(`Working directory: ${workingDir}`));
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// DiscordBot
// ============================================================================

export class DiscordBot {
	private client: Client;
	private handler: BotHandler;
	private workingDir: string;
	private botUserId: string | null = null;

	private users = new Map<string, DiscordUser>();
	private channels = new Map<string, DiscordChannel>();
	private queues = new Map<string, ChannelQueue>();

	constructor(
		handler: BotHandler,
		config: { botToken: string; workingDir: string },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
			partials: [Partials.Channel],
		});
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		this.setupEventHandlers();
		await this.client.login(process.env.DISCORD_BOT_TOKEN);
		this.botUserId = this.client.user?.id ?? null;
		logConnected();
	}

	getUser(userId: string): DiscordUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): DiscordChannel | undefined {
		return this.channels.get(channelId);
	}

	async postMessage(channelId: string, text: string): Promise<string> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel) {
			throw new Error(`Cannot post to channel ${channelId}`);
		}
		// Check if channel supports sending messages
		if (channel.type !== ChannelType.DM && !channel.isTextBased()) {
			throw new Error(`Cannot post to channel ${channelId}`);
		}
		const message = await (channel as TextChannel | DMChannel).send(text.slice(0, 2000));
		return message.id;
	}

	async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel) {
			throw new Error(`Cannot update message in channel ${channelId}`);
		}
		if (channel.type !== ChannelType.DM && !channel.isTextBased()) {
			throw new Error(`Cannot update message in channel ${channelId}`);
		}
		const message = await (channel as TextChannel | DMChannel).messages.fetch(messageId);
		await message.edit(text.slice(0, 2000));
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel) {
			return;
		}
		if (channel.type !== ChannelType.DM && !channel.isTextBased()) {
			return;
		}
		try {
			const message = await (channel as TextChannel | DMChannel).messages.fetch(messageId);
			await message.delete();
		} catch {
			// Ignore errors deleting messages
		}
	}

	async postInThread(channelId: string, threadId: string, text: string): Promise<string> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel || !channel.isTextBased()) {
			throw new Error(`Cannot post to thread in channel ${channelId}`);
		}
		// In Discord, we can reply to create a thread-like conversation
		const message = await (channel as TextChannel).send({
			content: text.slice(0, 2000),
			reply: { messageReference: threadId },
		});
		return message.id;
	}

	async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel) {
			throw new Error(`Cannot upload to channel ${channelId}`);
		}
		if (channel.type !== ChannelType.DM && !channel.isTextBased()) {
			throw new Error(`Cannot upload to channel ${channelId}`);
		}
		const fileContent = readFileSync(filePath);
		await (channel as TextChannel | DMChannel).send({
			files: [{ attachment: fileContent, name: title || basename(filePath) }],
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channelId: string, entry: object): void {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channelId: string, text: string, messageId: string): void {
		this.logToFile(channelId, {
			date: new Date().toISOString(),
			messageId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * Log a user message to log.jsonl
	 */
	logUserMessage(event: DiscordEvent): void {
		this.logToFile(event.channelId, {
			date: new Date().toISOString(),
			messageId: event.messageId,
			user: event.userId,
			userName: event.userName,
			displayName: event.displayName,
			text: event.text,
			attachments: event.attachments || [],
			isBot: false,
		});
	}

	/**
	 * Enqueue an event for processing
	 */
	enqueueEvent(event: DiscordEvent): boolean {
		const queue = this.getQueue(event.channelId);
		if (queue.size() >= 5) {
			logWarning(`Event queue full for ${event.channelId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		logInfo(`Enqueueing event for ${event.channelId}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this));
		return true;
	}

	getClient(): Client {
		return this.client;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		this.client.once(Events.ClientReady, () => {
			logStartup(this.workingDir);
		});

		this.client.on(Events.MessageCreate, async (message: Message) => {
			// Skip bot messages
			if (message.author.bot) return;
			// Skip messages without content or attachments
			if (!message.content && message.attachments.size === 0) return;

			const isDM = message.channel.type === ChannelType.DM;
			const isMention = message.mentions.has(this.client.user!.id);

			// Only process DMs or mentions
			if (!isDM && !isMention) return;

			// Extract text (remove bot mention)
			let text = message.content;
			if (isMention) {
				text = text.replace(new RegExp(`<@!?${this.client.user!.id}>`, "g"), "").trim();
			}

			// Build event
			const event: DiscordEvent = {
				type: isDM ? "dm" : "mention",
				channelId: message.channelId,
				messageId: message.id,
				userId: message.author.id,
				userName: message.author.username,
				displayName: message.author.displayName,
				text,
				attachments: message.attachments.map((a) => ({
					name: a.name || "attachment",
					url: a.url,
				})),
			};

			// Log user message
			this.logUserMessage(event);

			// Check for stop command - execute immediately
			if (event.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(event.channelId)) {
					await this.handler.handleStop(event.channelId, this);
				} else {
					await this.postMessage(event.channelId, "_Nothing running_");
				}
				return;
			}

			// Check if busy
			if (this.handler.isRunning(event.channelId)) {
				const busyMsg = isDM
					? "_Already working. Say `stop` to cancel._"
					: "_Already working. Say `@pi stop` to cancel._";
				await this.postMessage(event.channelId, busyMsg);
				return;
			}

			// Queue the event
			this.getQueue(event.channelId).enqueue(() => this.handler.handleEvent(event, this));
		});
	}
}
