# Patreon Discord Bot

A self-hostable Discord bot for podcasts and memberships that tracks active Patreon members, announces new patrons in Discord, and can optionally sync Patreon roles. It stores a local SQLite history, supports scheduled syncs, can react to Patreon webhooks, and exposes `/patreon` admin commands in your Discord server.

## What It Does

- Pulls Patreon campaign members from the Patreon API v2.
- Reads each member's linked Discord account from Patreon `social_connections`.
- Announces newly active patrons in a public Discord channel.
- Lists high-tier patrons with `/patreon saythanks`.
- Can optionally map Patreon tiers to Discord roles using Patreon tier `discord_role_ids`.
- Can optionally use a manual tier-to-role fallback with `PATREON_TIER_ROLE_MAP`.
- Keeps sync history and patron state in SQLite.
- Offers a webhook endpoint at `/webhooks/patreon` and a health check at `/healthz`.

## Requirements

- Node.js 22+ or Docker.
- A Discord application with a bot token.
- A Patreon creator access token with campaign member access.
- Patreon members must have connected Discord on Patreon for automatic Discord user matching.
- The Discord bot needs permission to view and send messages in the announcement channel.
- If you enable role management, the Discord bot needs `Manage Roles`, and its highest role must sit above every patron role it manages.
- Enable the Discord server members intent for the bot in the Discord Developer Portal.

## Setup

1. Copy the environment template:

   ```sh
   cp .env.example .env
   ```

2. Create a Patreon OAuth client.

   In the Patreon client form, these are the important fields:

   - `Description`: any label, such as `bitflip-patreon-bot`.
   - `App Category`: `Podcast`.
   - `Redirect URIs`: `http://localhost:3000/oauth/callback` for local setup.
   - `Client API Version`: `2`.

   If you will host the bot publicly, add your production callback too, separated by a space:

   ```text
   http://localhost:3000/oauth/callback https://your-domain.example/oauth/callback
   ```

   Patreon requires the callback URL to match exactly. The webhook URL is different; use `/webhooks/patreon` only when configuring webhooks.

3. Fill in `.env`:

   - `DISCORD_TOKEN`: your Discord bot token.
   - `DISCORD_CLIENT_ID`: your Discord application client ID.
   - `DISCORD_GUILD_ID`: the server to install commands into.
   - `PATREON_CLIENT_ID`: your Patreon OAuth client ID.
   - `PATREON_CLIENT_SECRET`: your Patreon OAuth client secret.
   - `PATREON_OAUTH_REDIRECT_URI`: the redirect URI you entered in Patreon, usually `http://localhost:3000/oauth/callback`.
   - `PATREON_SETUP_TOKEN`: recommended for public hosting. Use a long random value and open `/oauth/start?setup_token=that-value`.
   - `PATREON_CAMPAIGN_ID`: optional if your OAuth account has one campaign; the setup flow can save it automatically.
   - `PATREON_ACCESS_TOKEN`, `PATREON_REFRESH_TOKEN`: optional if you use the OAuth setup flow.
   - `PATREON_WEBHOOK_SECRET`: optional. Add it if you configure a Patreon webhook.
   - `MANAGE_DISCORD_ROLES`: keep this `false` when the official Patreon Discord bot manages roles.
   - `ANNOUNCEMENT_CHANNEL_NAME`: the public channel for new patron thanks, such as `chit-chat`.
   - `THANKS_TIER_NAME`: the tier name used by `/patreon saythanks`, such as `terrabyte`.

4. Install dependencies and register Discord slash commands:

   ```sh
   npm install
   npm run deploy:commands
   ```

5. Run locally:

   ```sh
   npm run dev
   ```

6. In a browser, visit:

   ```text
   http://localhost:3000/oauth/start
   ```

   Approve the Patreon OAuth request. The bot stores the access token and refresh token in SQLite. If Patreon returns exactly one campaign, the bot stores that campaign ID too.

## Docker

```sh
cp .env.example .env
docker compose up -d --build
```

SQLite data is stored in `./data` by default.

The production image expected by the infra repo is:

```text
ghcr.io/ironicbadger/bitflip-patreon-bot:latest
```

The included GitHub Actions workflow publishes that image on pushes to `main` and version tags.

For Docker-based OAuth setup, use the same callback URL that reaches the container. With the default Compose file, local setup is:

```text
http://localhost:3000/oauth/callback
```

## Hosting Model

The bot does not need a public HTTP server just to stay connected to Discord. Discord gateway traffic is outbound from the bot, and scheduled Patreon syncs are outbound API calls.

You need a public HTTPS URL only for:

- Patreon OAuth setup directly on the hosted machine.
- Patreon webhooks for near-instant syncs.

For a VPS setup, point a domain at the VPS and reverse proxy HTTPS traffic to the bot's `WEBHOOK_PORT`. For example:

```text
https://patreon-bot.your-domain.example/oauth/callback
https://patreon-bot.your-domain.example/webhooks/patreon
```

Then set:

```env
PUBLIC_HOSTNAME=patreon-bot.your-domain.example
PATREON_OAUTH_REDIRECT_URI=https://patreon-bot.your-domain.example/oauth/callback
PATREON_SETUP_TOKEN=use-a-long-random-secret
```

Add the exact OAuth callback URL to Patreon's `Redirect URIs`, restart the bot, then open:

```text
https://patreon-bot.your-domain.example/oauth/start?setup_token=use-a-long-random-secret
```

The setup token only protects the OAuth setup launcher. Patreon still returns to `/oauth/callback` using a short-lived state value.

You can also do OAuth setup locally and then copy `./data/patreon-bot.sqlite` to the VPS, but running setup on the final host is usually simpler because the tokens land in the same persistent volume the bot will use.

Host-specific reverse proxy labels, DNS, and secrets should live in your infra repo. Keep this app repo focused on the bot image and local self-hosting defaults.

## Discord Commands

- `/patreon sync`: run a sync now.
- `/patreon sync dry_run:true`: preview role changes without applying them.
- `/patreon status`: show the latest sync summary and local counts.
- `/patreon saythanks`: list active patrons at the configured high-tier threshold or higher.
- `/patreon member user:@name`: inspect a tracked Patreon link for one Discord user.

Only Discord administrators can use these commands by default. To also allow a staff role, set `COMMAND_ALLOWLIST_ROLE_IDS` to a comma-separated list of Discord role IDs.

## Patron Announcements

Set `ANNOUNCEMENTS_ENABLED=true` and `ANNOUNCEMENT_CHANNEL_NAME=chit-chat` to thank newly active patrons in that channel. The bot records which Patreon member IDs it has announced so normal syncs do not repeatedly thank the same person.

The first sync against an empty database does not backfill announcements for everyone already active. After at least one sync has been recorded, newly discovered active patrons and patrons who become active again are announced.

## Tier Mapping

Role management is disabled by default so this bot does not conflict with the official Patreon Discord bot. Enable it only if you want this bot to manage roles itself:

```env
MANAGE_DISCORD_ROLES=true
```

The best path is to configure Patreon tiers with Discord benefits so Patreon exposes `discord_role_ids`. If you need a fallback, set:

```env
PATREON_TIER_ROLE_MAP=patreonTierId:discordRoleId,anotherTierId:anotherDiscordRoleId
```

Manual mappings are additive, so they can supplement Patreon-provided role IDs.

## Webhooks

The bot runs an HTTP server on `WEBHOOK_PORT`.

- Health check: `GET /healthz`
- Patreon webhook: `POST /webhooks/patreon`

If you expose this to the internet, put it behind HTTPS with a reverse proxy such as Caddy, nginx, or a tunnel provider. Add the same webhook secret in Patreon and `PATREON_WEBHOOK_SECRET`; the bot verifies Patreon `X-Patreon-Signature` using the raw request body.

Webhooks trigger a full sync rather than trusting the webhook payload alone, which keeps role state consistent after missed events.

## Notes

- Set `DRY_RUN=true` for first launch if you want to verify the counts before applying Discord role changes.
- When `MANAGE_DISCORD_ROLES=false`, the bot never adds or removes Discord roles.
- When role management is enabled, the bot only removes role grants it has recorded in SQLite. It will not strip manually assigned roles that predate the bot.
- If Patreon tokens expire and refresh credentials are not configured, the next sync will fail until you provide a new access token.
- This implementation follows the current Patreon API v2 member shape and Discord role-management constraints. Useful references: [Patreon API docs](https://docs.patreon.com/) and [Discord Developer Docs](https://discord.com/developers/docs/intro).
