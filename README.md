# Pi Discord Bot

A Discord bot for the [pi coding agent](https://github.com/badlogic/pi-mono), similar to the Slack bot (mom).

Works with **DMs** and **@mentions** in channels.

## Features

- ✅ Direct Messages (DM) - talk to the bot privately
- ✅ @mentions in channels - mention the bot to trigger it
- ✅ Stop command - say "stop" to cancel a running task
- ✅ File attachments - logs attachments with messages
- ✅ Message logging - all conversations saved to `log.jsonl`
- ✅ Queue system - per-channel sequential processing

## Setup

### 1. Create Discord Bot Application

1. Go to https://discord.com/developers/applications
2. Click **"New Application"** → give it a name (e.g., "pi-bot")
3. Go to **"Bot"** tab on the left
4. Click **"Add Bot"**
5. Under **"Privileged Gateway Intents"**, enable:
   - ✅ **Message Content Intent** (required to read message content)
6. Click **"Reset Token"** and copy the token
7. Set the token in your environment:
   ```bash
   export DISCORD_BOT_TOKEN="your-token-here"
   ```
   Or copy `.env.example` to `.env` and fill it in.

### 2. Invite Bot to Your Server

1. In the Discord Developer Portal, go to **"OAuth2"** → **"URL Generator"**
2. Under **Scopes**, select:
   - ✅ **bot**
3. Under **Bot Permissions**, select:
   - ✅ **Send Messages**
   - ✅ **Read Message History**
   - ✅ **Attach Files**
   - ✅ **Embed Links**
   - ✅ **Add Reactions**
   - ✅ **Use External Emojis**
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

### 3. Install Dependencies

```bash
bun install
```

Or with npm:
```bash
bun install
```

### 4. Quick Start (Development)

```bash
# Set your tokens
export DISCORD_BOT_TOKEN="your-discord-token-here"
export KIMI_API_KEY="your-kimi-key-here"

# Create a working directory
mkdir -p /tmp/pi-discord-work

# Run the bot
bun run build
bun dist/main.js /tmp/pi-discord-work
```

Or use the npm script:
```bash
DISCORD_BOT_TOKEN="..." KIMI_API_KEY="..." bun start /path/to/working-directory
```

For development with auto-reload:
```bash
bun run start:dev /path/to/working-directory
```

## Usage

### Direct Messages (DM)

1. Find your bot in Discord's DM list
2. Send any message
3. The bot will respond

### Channel Mentions

In any channel the bot has access to:
```
@pi-bot write a hello world in typescript
```

### Stop Command

To stop a running task:
- In DM: just say `stop`
- In channel: say `@pi-bot stop`

## Project Structure

```
pi-discord/
├── src/
│   ├── discord.ts    # Discord bot wrapper (Discord.js)
│   └── main.ts       # Entry point and agent wiring
├── dist/             # Compiled output
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

The bot follows the same architecture as the Slack bot (mom):

```
Discord Gateway (WebSocket)
    ↓
DiscordBot class (discord.ts)
    ↓
BotHandler interface
    ↓
Agent integration (main.ts)
```

### Key Classes

- **`DiscordBot`** - Wraps Discord.js client, handles events, provides API
- **`ChannelQueue`** - Ensures sequential processing per channel
- **`DiscordContext`** - Provides context for agent responses (typing, editing, etc.)

## Logging

All messages are logged to:
```
<working-directory>/<channel-id>/log.jsonl
```

Each entry is a JSON line with:
```json
{
  "date": "2024-01-15T10:30:00.000Z",
  "messageId": "123456789",
  "user": "user-id",
  "userName": "username",
  "displayName": "Display Name",
  "text": "message text",
  "attachments": [],
  "isBot": false
}
```

## Integrating with Pi Coding Agent

The current implementation has a placeholder `runAgent()` function. To integrate with the actual pi-coding-agent:

1. Install the package:
   ```bash
   bun add @mariozechner/pi-coding-agent
   ```

2. In `src/main.ts`, replace the placeholder `runAgent()` with actual agent integration:
   ```typescript
   import { AgentRunner } from "@mariozechner/pi-coding-agent";
   
   // Create runner per channel
   const runner = new AgentRunner({
     workingDir: join(workingDir, channelId),
     // ... other config
   });
   
   // Run with context
   await runner.run(ctx, text);
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ Yes | Bot token from Discord Developer Portal |
| `KIMI_API_KEY` | ✅ Yes | Kimi API key from Moonshot AI |

### Setting up Kimi API Key

Get your API key from https://platform.moonshot.cn/

Then either:
1. Set the environment variable: `export KIMI_API_KEY="your-key-here"`
2. Or create an auth file at `~/.pi/auth.json`:

```bash
mkdir -p ~/.pi
cat > ~/.pi/auth.json << 'EOF'
{
  "kimi-coding": {
    "type": "apiKey",
    "apiKey": "your-kimi-api-key"
  }
}
EOF
chmod 600 ~/.pi/auth.json
```

The bot uses **Kimi K2.5** model via the Kimi Coding API (`https://api.kimi.com/coding`).

## Commands

| Command | Description |
|---------|-------------|
| `stop` | Stop the current running task |

## Development Mode

```bash
# Install dependencies
bun install

# Build and watch for changes (TypeScript compilation)
bun run dev

# In another terminal, run with auto-reload
bun run start:dev /path/to/working-dir
```

## Production (Single Binary)

Bun can compile everything into a single binary:

```bash
# Build and compile to single binary
bun run compile:all

# Or manually:
bun run build
bun run compile

# Run the binary
./pi-discord /path/to/working-dir
```

The binary is self-contained (~110MB) and doesn't need node_modules or TypeScript compilation on the target machine. Just set the environment variables and run:

```bash
export DISCORD_BOT_TOKEN="your-token-here"
export KIMI_API_KEY="your-kimi-key-here"
./pi-discord /path/to/working-dir
```

## License

MIT
