#!/usr/bin/env node

import { resolve, join } from "path";
import { DiscordBot, type DiscordEvent, type BotHandler, type DiscordContext } from "./discord.js";
import { getOrCreateRunner, type AgentRunner } from "./agent.js";
import chalk from "chalk";

// ============================================================================
// Config
// ============================================================================

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

interface ParsedArgs {
	workingDir: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let workingDir: string | undefined;

	for (const arg of args) {
		if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	if (!workingDir) {
		console.error("Usage: pi-discord <working-directory>");
		process.exit(1);
	}

	return { workingDir: resolve(workingDir) };
}

const { workingDir } = parseArgs();

if (!DISCORD_BOT_TOKEN) {
	console.error("Missing env: DISCORD_BOT_TOKEN");
	console.error("Get your bot token from https://discord.com/developers/applications");
	process.exit(1);
}

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	stopRequested: boolean;
	stopMessageId?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(channelId, channelDir),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create DiscordContext adapter
// ============================================================================

function createDiscordContext(
	event: DiscordEvent,
	bot: DiscordBot,
	state: ChannelState,
): DiscordContext {
	let messageId: string | null = null;
	let thinkingMessageId: string | null = null;
	const threadMessageIds: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ⏳";
	let updatePromise = Promise.resolve();

	const channel = bot.getChannel(event.channelId);

	return {
		message: {
			text: event.text,
			rawText: event.text,
			userId: event.userId,
			userName: event.userName,
			displayName: event.displayName,
			channelId: event.channelId,
			messageId: event.messageId,
			attachments: event.attachments || [],
		},
		channelName: channel?.name,
		isDM: event.type === "dm",
		guildName: undefined, // Could be fetched if needed

		respond: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

				if (messageId) {
					// If we already have a message, update it (streaming mode)
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await bot.updateMessage(event.channelId, messageId, displayText);
				} else {
					// Post as new message (triggers notification)
					messageId = await bot.postMessage(event.channelId, accumulatedText);
				}

				bot.logBotResponse(event.channelId, text, messageId);
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;

				if (messageId) {
					// Update existing message
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await bot.updateMessage(event.channelId, messageId, displayText);
				} else {
					// Post as new message (triggers notification)
					messageId = await bot.postMessage(event.channelId, accumulatedText);
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				if (messageId) {
					const id = await bot.postInThread(event.channelId, messageId, text);
					threadMessageIds.push(id);
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !thinkingMessageId) {
				updatePromise = updatePromise.then(async () => {
					if (!thinkingMessageId) {
						thinkingMessageId = await bot.postMessage(
							event.channelId,
							"_Thinking..._" + workingIndicator,
						);
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await bot.uploadFile(event.channelId, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (!isWorking && thinkingMessageId) {
					// Delete the thinking message and reset to send fresh message
					await bot.deleteMessage(event.channelId, thinkingMessageId);
					thinkingMessageId = null;
					// Reset messageId so respond() posts a new message (triggers notification)
					messageId = null;
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageIds.length - 1; i >= 0; i--) {
					try {
						await bot.deleteMessage(event.channelId, threadMessageIds[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageIds.length = 0;
				// Then delete main message
				if (messageId) {
					await bot.deleteMessage(event.channelId, messageId);
					messageId = null;
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: BotHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, bot: DiscordBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const messageId = await bot.postMessage(channelId, "_Stopping..._");
			state.stopMessageId = messageId;
		} else {
			await bot.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: DiscordEvent, bot: DiscordBot): Promise<void> {
		const state = getState(event.channelId);

		// Start run
		state.running = true;
		state.stopRequested = false;

		console.log(
			chalk.cyan(`[${event.channelId}]`),
			`Starting run: ${event.text.substring(0, 50)}`,
		);

		try {
			// Create context adapter
			const ctx = createDiscordContext(event, bot, state);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);

			// Run agent with the real pi-coding-agent
			const result = await state.runner.run(ctx, event.text);

			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageId) {
					await bot.updateMessage(event.channelId, state.stopMessageId, "_Stopped_");
					state.stopMessageId = undefined;
				} else {
					await bot.postMessage(event.channelId, "_Stopped_");
				}
			}
		} catch (err) {
			console.error(
				chalk.red(`[${event.channelId}] Run error:`),
				err instanceof Error ? err.message : String(err),
			);
			await bot.postMessage(
				event.channelId,
				`_Error: ${err instanceof Error ? err.message : String(err)}_`,
			);
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

const bot = new DiscordBot(handler, {
	botToken: DISCORD_BOT_TOKEN,
	workingDir,
});

// Handle shutdown
process.on("SIGINT", () => {
	console.log(chalk.yellow("\nShutting down..."));
	bot.getClient().destroy();
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log(chalk.yellow("\nShutting down..."));
	bot.getClient().destroy();
	process.exit(0);
});

// Start the bot
await bot.start();
