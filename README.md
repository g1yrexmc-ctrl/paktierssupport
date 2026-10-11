# EclipseMC Discord Moderation & Tickets

EclipseMC is a single Node.js service containing:
- Discord slash-command moderation (`/ban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/clear`, `/slowmode`, `/lock`, `/unlock`, `/modlogs`, `/ticket`, `/help`).
- Button-based ticket creation, close/lock, add/remove users, and transcript files.
- Web dashboard for moderation logs, ticket status, ticket/custom embed panel design, channel/role settings, command toggles, and per-command role allowlists.
- JSON-backed storage on a Railway Volume; transcripts are also written to that volume.
- Password-protected dashboard with HTTP-only session cookies and login rate limiting.

> “Premium” here means the included feature set; it is not a claim of a commercial license or paid Discord feature.

## 1. Discord application setup

1. Create an application in the Discord Developer Portal and add a **Bot**.
2. Copy the bot token. Never commit it to GitHub or paste it into a public issue.
3. Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`.
4. Grant only the permissions the bot needs. For the included features, this typically includes View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels, Manage Messages, Moderate Members, Kick Members, and Ban Members. The bot's role must be above members it moderates and above roles it needs to grant ticket access to.
5. Optional audit events: if you enable **Server Members Intent** under Bot → Privileged Gateway Intents, set `ENABLE_MEMBER_EVENTS=true` in Railway to log member joins/leaves and welcome messages. If you enable **Message Content Intent**, set `ENABLE_MESSAGE_CONTENT_LOGS=true` to turn on message-edit/delete audit entries (including available message text). Keep both disabled if you do not need those events; slash commands, core moderation, and tickets work without the privileged intents.
6. Invite the bot to the server.

The dashboard automatically looks for your logo at `public/logo.png`; add that file yourself. If it is absent, it displays an `E` fallback mark.

## 2. Deploy from GitHub to Railway

1. Push this `main` folder's contents to a GitHub repository (the repository root should contain `api_server.js` and `package.json`).
2. In Railway, create a project → **Deploy from GitHub Repo** and choose the repository. Railway detects Node and runs `npm start` from `package.json`.
3. In the service's **Variables** tab, add the required variables listed below.
4. In the service's **Volumes** section, create/attach a volume mounted at `/data`. Set `DATA_DIR` to `/data`. Attach it to the same service that runs the bot. Without a volume, JSON records and transcripts inside the container can be lost on redeploy/restart.
5. Generate a public domain under **Settings → Networking** so you can open the web dashboard.
6. Check Deploy Logs. When Discord login succeeds, open your Railway domain and sign into the dashboard using `DASHBOARD_PASSWORD`.

## 3. Railway variables

**Required**

| Variable | Value |
|---|---|
| `BOT_TOKEN` | Bot token from Discord Developer Portal. Keep secret. |
| `CLIENT_ID` | Discord application's Application ID (not the bot token). |
| `DASHBOARD_PASSWORD` | A unique password for the web dashboard (minimum 16 characters; 20+ recommended). |
| `SESSION_SECRET` | A random string of at least 32 characters used to sign sessions. |

**Recommended / optional**

| Variable | Value |
|---|---|
| `GUILD_ID` | Your test server ID while testing. Leave blank to register commands globally. |
| `DATA_DIR` | `/data` when your Railway volume mount path is `/data`. |
| `ENABLE_MEMBER_EVENTS` | `true` only if Server Members Intent is enabled in the Discord Developer Portal; enables join/leave logs and welcome messages. Default: `false`. |
| `ENABLE_MESSAGE_CONTENT_LOGS` | `true` only if Message Content Intent is enabled; captures message content in edit/delete logs. Default: `false`. |
| `NODE_ENV` | `production` on Railway. |
| `PORT` | Railway supplies this automatically; do not hard-code it. |

When a Railway Volume is attached, `RAILWAY_VOLUME_MOUNT_PATH` is automatically provided. If `DATA_DIR` is unset, the app falls back to that value and then to local `./data`.

Generate secrets locally with e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Generate a different value for `SESSION_SECRET` and never commit either secret.

## 4. Dashboard features

- **Overview:** online state, server count, open tickets, configured panels, recent logs.
- **Moderation logs:** audit entries for bot moderation commands and configured Discord events.
- **Tickets:** list open/closed tickets and jump to the Discord channel.
- **Panel maker:** save ticket or custom panels, customize title/description/color/footer/button, select a channel, publish/update, or remove the panel.
- **Settings:** log channel, ticket category, support/moderator roles, welcome channel/message, default embed color/footer.
- **Permissions:** disable commands and optionally restrict them to selected roles. If no custom roles are selected, the command's normal Discord permission requirements apply. Server Administrators bypass role allowlists (but a disabled command remains disabled).

## 5. Useful notes

- Moderation actions also require the bot to have the corresponding Discord permission and the correct role hierarchy.
- `/ticket setup` publishes a basic ticket panel in the current channel. The dashboard panel maker can customize it.
- Closed ticket transcripts are saved in `DATA_DIR/transcripts/` and attached to the configured log channel if one is configured.
- Logs and warnings are capped to keep the JSON file from growing without bound. Make regular volume backups for valuable records.
- The dashboard uses one shared password configured in Railway. Treat it as an administrator credential; share it only with trusted people. For a multi-admin public SaaS, add Discord OAuth and per-user ownership before exposing it to customers.
- Railway volume mount points are runtime mounts. Do not expect files created in that directory during the build to persist.
