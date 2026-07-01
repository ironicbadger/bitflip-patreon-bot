import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  Partials
} from "discord.js";
import { config } from "./config";
import { handlePatreonCommand } from "./commands";
import { AppDatabase } from "./database";
import { Logger } from "./logger";
import { PatreonClient } from "./patreonClient";
import { SyncService } from "./syncService";
import { WebhookServer } from "./webhookServer";

const logger = new Logger(config.logLevel);
const database = new AppDatabase(config.databasePath);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

const patreonClient = new PatreonClient(
  {
    accessToken: config.patreonAccessToken,
    refreshToken: config.patreonRefreshToken,
    clientId: config.patreonClientId,
    clientSecret: config.patreonClientSecret,
    campaignId: config.patreonCampaignId
  },
  database,
  logger
);

const syncService = new SyncService(client, patreonClient, database, logger, {
  guildId: config.discordGuildId,
  dryRun: config.dryRun,
  tierRoleMap: config.patreonTierRoleMap,
  manageDiscordRoles: config.manageDiscordRoles,
  announcementsEnabled: config.announcementsEnabled,
  announcementChannelName: config.announcementChannelName
});

const webhookServer = new WebhookServer(syncService, patreonClient, database, logger, {
  port: config.webhookPort,
  patreonWebhookSecret: config.patreonWebhookSecret,
  patreonOAuthRedirectUri: config.patreonOAuthRedirectUri,
  patreonOAuthScopes: config.patreonOAuthScopes,
  patreonSetupToken: config.patreonSetupToken
});

let syncInterval: NodeJS.Timeout | null = null;

client.once(Events.ClientReady, async (readyClient) => {
  logger.info("Discord bot logged in", { user: readyClient.user.tag });
  webhookServer.start();

  if (config.syncOnStart && patreonClient.hasSyncConfiguration()) {
    void syncService.sync("startup").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Startup sync failed", { message });
    });
  } else if (!patreonClient.hasSyncConfiguration()) {
    logger.warn("Patreon sync is not configured yet; complete OAuth setup at /oauth/start or set tokens in .env");
  }

  syncInterval = setInterval(
    () => {
      if (!patreonClient.hasSyncConfiguration()) {
        logger.debug("Skipping interval sync until Patreon setup is complete");
        return;
      }
      void syncService.sync("interval").catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Interval sync failed", { message });
      });
    },
    config.syncIntervalMinutes * 60 * 1000
  );
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "patreon") {
    return;
  }

  try {
    await handlePatreonCommand(interaction, {
      database,
      syncService,
      allowlistRoleIds: config.commandAllowlistRoleIds,
      thanksTierName: config.thanksTierName
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Command failed", { message });

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Command failed: ${message}`);
    } else {
      await interaction.reply({ content: `Command failed: ${message}`, ephemeral: true });
    }
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutting down", { signal });
  if (syncInterval) {
    clearInterval(syncInterval);
  }
  await webhookServer.stop();
  client.destroy();
  database.close();
}

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

client.login(config.discordToken).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("Unable to log in to Discord", { message });
  process.exitCode = 1;
});
