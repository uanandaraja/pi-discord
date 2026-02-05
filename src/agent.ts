import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	createCodingTools,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { DiscordContext } from "./discord.js";
import chalk from "chalk";

// ============================================================================
// Simple Settings Manager
// ============================================================================

interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

interface DiscordSettings {
	compaction?: Partial<CompactionSettings>;
	retry?: Partial<RetrySettings>;
}

const DEFAULT_COMPACTION: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: RetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

class SimpleSettingsManager {
	private settingsPath: string;
	private settings: DiscordSettings;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	private load(): DiscordSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}
		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch {
			// Ignore save errors
		}
	}

	getCompactionSettings(): CompactionSettings {
		return { ...DEFAULT_COMPACTION, ...this.settings.compaction };
	}

	getRetrySettings(): RetrySettings {
		return { ...DEFAULT_RETRY, ...this.settings.retry };
	}

	// Image settings
	getImageAutoResize(): boolean {
		return true;
	}

	setImageAutoResize(_enabled: boolean): void {}

	getBlockImages(): boolean {
		return false;
	}

	setBlockImages(_blocked: boolean): void {}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {}

	getHookPaths(): string[] {
		return [];
	}

	getHookTimeout(): number {
		return 30000;
	}

	getEnabledModels(): string[] | undefined {
		return undefined;
	}

	setEnabledModels(_patterns: string[] | undefined): void {}

	isModelEnabled(_modelId: string): boolean {
		return true;
	}

	getShowImages(): boolean {
		return true;
	}

	setShowImages(_enabled: boolean): void {}

	getClearOnShrink(): boolean {
		return false;
	}

	setClearOnShrink(_enabled: boolean): void {}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	setShellCommandPrefix(_prefix: string | undefined): void {}

	getDefaultShell(): string | undefined {
		return undefined;
	}

	setDefaultShell(_shell: string | undefined): void {}

	getHideThinkingBlock(): boolean {
		return false;
	}

	setHideThinkingBlock(_hide: boolean): void {}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | undefined {
		return "off";
	}

	setDefaultThinkingLevel(_level: "off" | "minimal" | "low" | "medium" | "high"): void {}

	getTheme(): string | undefined {
		return undefined;
	}

	setTheme(_theme: string): void {}

	getDefaultProvider(): string | undefined {
		return "kimi-coding";
	}

	getDefaultModel(): string | undefined {
		return "k2p5";
	}

	setDefaultProvider(_provider: string): void {}

	setDefaultModel(_modelId: string): void {}

	setDefaultModelAndProvider(_provider: string, _modelId: string): void {}

	getQuietStartup(): boolean {
		return false;
	}

	setQuietStartup(_quiet: boolean): void {}

	getCollapseChangelog(): boolean {
		return false;
	}

	setCollapseChangelog(_collapse: boolean): void {}

	getShellPath(): string | undefined {
		return undefined;
	}

	setShellPath(_path: string | undefined): void {}

	getExtensionPaths(): string[] {
		return [];
	}

	setExtensionPaths(_paths: string[]): void {}

	getPackages(): unknown[] {
		return [];
	}

	setPackages(_packages: unknown[]): void {}

	setProjectPackages(_packages: unknown[]): void {}

	getGlobalSettings(): unknown {
		return {};
	}

	getProjectSettings(): unknown {
		return {};
	}

	getLastChangelogVersion(): string | undefined {
		return undefined;
	}

	setLastChangelogVersion(_version: string): void {}

	getCompactionEnabled(): boolean {
		return DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(_enabled: boolean): void {}

	getRetryEnabled(): boolean {
		return DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(_enabled: boolean): void {}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: 16384 };
	}

	getCompactionReserveTokens(): number {
		return DEFAULT_COMPACTION.reserveTokens;
	}

	getCompactionKeepRecentTokens(): number {
		return DEFAULT_COMPACTION.keepRecentTokens;
	}

	getMaxRetries(): number {
		return DEFAULT_RETRY.maxRetries;
	}

	getRetryDelayMs(): number {
		return DEFAULT_RETRY.baseDelayMs;
	}

	getMaxRetryDelayMs(): number {
		return 60000;
	}
}

// Hardcoded model - uses Kimi Coding API with K2.5
const model = getModel("kimi-coding", "k2p5");

export interface AgentRunner {
	run(ctx: DiscordContext, text: string): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
}

async function getKimiApiKey(authStorage: AuthStorage): Promise<string> {
	// First check environment variable
	const envKey = process.env.KIMI_API_KEY;
	if (envKey) {
		return envKey;
	}
	
	// Then check auth storage
	const key = await authStorage.getApiKey("kimi-coding");
	if (!key) {
		throw new Error(
			"No API key found for Kimi Coding.\n\n" +
				"Set KIMI_API_KEY environment variable, or create auth.json at " +
				join(homedir(), ".pi", "auth.json"),
		);
	}
	return key;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function logInfo(message: string): void {
	console.log(chalk.blue("ℹ"), message);
}

function logWarning(message: string, detail?: string): void {
	console.log(chalk.yellow("⚠"), message, detail ? chalk.gray(`(${detail})`) : "");
}

function buildSystemPrompt(workspacePath: string, channelId: string): string {
	return `You are pi, a Discord bot assistant. Be concise. Use Discord markdown.

## Context
- Current working directory: ${workspacePath}/${channelId}
- Use this directory for all file operations
- For current date/time, use: date

## Discord Markdown
Bold: **text**, Italic: *text* or _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)

## Workspace Layout
${workspacePath}/
└── ${channelId}/              # This channel/conversation
    ├── log.jsonl            # Message history
    ├── context.jsonl        # Agent context
    └── files/               # Your working directory

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits

Keep responses concise and actionable.
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}
	return JSON.stringify(result);
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 */
export function getOrCreateRunner(channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}

function createRunner(channelId: string, channelDir: string): AgentRunner {
	const workspacePath = join(channelDir, "..");

	// Create system prompt
	const systemPrompt = buildSystemPrompt(workspacePath, channelId);

	// Create tools using the SDK
	const tools = createCodingTools(channelDir);

	// Create AuthStorage and ModelRegistry
	const authStorage = new AuthStorage(join(homedir(), ".pi", "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getKimiApiKey(authStorage),
	});

	// Create session manager and settings manager
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = new SimpleSettingsManager(join(channelDir, ".."));

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: channelDir,
		modelRegistry,
		resourceLoader,
	});

	// Mutable per-run state
	const runState = {
		ctx: null as DiscordContext | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		if (!runState.ctx || !runState.queue) return;

		const { ctx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			logInfo(`Tool start: ${agentEvent.toolName} - ${label}`);
			// queue.enqueue(() => ctx.respond(`_→ ${label}_`), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;
			const duration = (durationMs / 1000).toFixed(1);

			if (agentEvent.isError) {
				logWarning(`Tool error: ${agentEvent.toolName}`, resultStr);
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`), "tool error");
			} else {
				logInfo(`Tool success: ${agentEvent.toolName} (${duration}s)`);
				// Tool results are logged but not sent to Discord
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				logInfo("Response started");
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");
				if (text.trim()) {
					queue.enqueueMessage(text, "main", "response main");
				}
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`),
				"retry",
			);
		}
	});

	// Discord message limit (2000 chars)
	const DISCORD_MAX_LENGTH = 2000;
	const splitForDiscord = (text: string): string[] => {
		if (text.length <= DISCORD_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		while (remaining.length > 0) {
			// Find a good break point
			let chunk = remaining.substring(0, DISCORD_MAX_LENGTH - 10);
			const lastNewline = chunk.lastIndexOf("\n");
			const lastSpace = chunk.lastIndexOf(" ");
			if (lastNewline > DISCORD_MAX_LENGTH * 0.7) {
				chunk = chunk.substring(0, lastNewline);
			} else if (lastSpace > DISCORD_MAX_LENGTH * 0.7) {
				chunk = chunk.substring(0, lastSpace);
			}
			remaining = remaining.substring(chunk.length).trim();
			const suffix = remaining.length > 0 ? "\n_(continued...)_" : "";
			parts.push(chunk + suffix);
		}
		return parts;
	};

	return {
		async run(ctx: DiscordContext, text: string): Promise<{ stopReason: string; errorMessage?: string }> {
			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });
			await mkdir(join(channelDir, "files"), { recursive: true });

			// Reload messages from context.jsonl
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
			}

			// Reset per-run state
			runState.ctx = ctx;
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							logWarning(`Discord API error (${errorContext})`, errMsg);
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", _errorContext: string, _doLog = true): void {
					const parts = splitForDiscord(text);
					for (const part of parts) {
						this.enqueue(
							() => {
								if (target === "main") {
									return ctx.respond(part);
								} else {
									return ctx.respondInThread(part);
								}
							},
							target,
						);
					}
				},
			};

			// Build user message
			const userMessage = `[${ctx.message.userName}]: ${text}`;

			// Handle image attachments
			const imageAttachments: ImageContent[] = [];
			for (const a of ctx.message.attachments || []) {
				const mimeType = getImageMimeType(a.name);
				if (mimeType && a.url) {
					try {
						// Download image from URL
						const response = await fetch(a.url);
						const buffer = await response.arrayBuffer();
						imageAttachments.push({
							type: "image",
							mimeType,
							data: Buffer.from(buffer).toString("base64"),
						});
					} catch {
						// Ignore failed image downloads
					}
				}
			}

			// Debug: write context to last_prompt.json
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2));

			// Send initial typing indicator
			await ctx.setTyping(true);

			// Run the agent
			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// Handle final message
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					logWarning("Failed to post error message", String(err));
				}
			} else {
				// Get final text from last assistant message
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				if (finalText.trim()) {
					try {
						await ctx.replaceMessage(finalText);
					} catch (err) {
						logWarning("Failed to replace message with final text", String(err));
					}
				}
			}

			// Log usage summary
			if (runState.totalUsage.cost.total > 0) {
				const usage = runState.totalUsage;
				const summary = [
					`📊 **Usage:**`,
					`Input: ${usage.input.toLocaleString()} tokens`,
					`Output: ${usage.output.toLocaleString()} tokens`,
					`Cache read: ${usage.cacheRead.toLocaleString()} tokens`,
					`Cost: $${usage.cost.total.toFixed(4)}`,
				].join("\n");
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},
	};
}
