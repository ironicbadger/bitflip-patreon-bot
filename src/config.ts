import "dotenv/config";
import { z } from "zod";
import type { LogLevel } from "./types";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  PATREON_ACCESS_TOKEN: z.string().optional().default(""),
  PATREON_CAMPAIGN_ID: z.string().optional().default(""),
  PATREON_CLIENT_ID: z.string().optional().default(""),
  PATREON_CLIENT_SECRET: z.string().optional().default(""),
  PATREON_REFRESH_TOKEN: z.string().optional().default(""),
  PATREON_OAUTH_REDIRECT_URI: z.string().optional().default(""),
  PATREON_OAUTH_SCOPES: z.string().optional().default("identity identity[email] campaigns campaigns.members"),
  PATREON_SETUP_TOKEN: z.string().optional().default(""),
  PATREON_TIER_ROLE_MAP: z.string().optional().default(""),
  DATABASE_PATH: z.string().optional().default("./data/patreon-bot.sqlite"),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().optional().default(60),
  SYNC_ON_START: z
    .string()
    .optional()
    .default("true")
    .transform((value) => parseBoolean(value)),
  DRY_RUN: z
    .string()
    .optional()
    .default("false")
    .transform((value) => parseBoolean(value)),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .optional()
    .default("info"),
  WEBHOOK_PORT: z.coerce.number().int().positive().optional().default(3000),
  PATREON_WEBHOOK_SECRET: z.string().optional().default(""),
  COMMAND_ALLOWLIST_ROLE_IDS: z.string().optional().default("")
});

function parseBoolean(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTierRoleMap(value: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pair of parseCsv(value)) {
    const [tierId, roleId] = pair.split(":").map((item) => item?.trim());
    if (!tierId || !roleId) {
      throw new Error(`Invalid PATREON_TIER_ROLE_MAP entry "${pair}". Expected patreonTierId:discordRoleId.`);
    }
    const existing = map.get(tierId) ?? [];
    existing.push(roleId);
    map.set(tierId, existing);
  }
  return map;
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const config = {
  discordToken: parsed.data.DISCORD_TOKEN,
  discordClientId: parsed.data.DISCORD_CLIENT_ID,
  discordGuildId: parsed.data.DISCORD_GUILD_ID,
  patreonAccessToken: parsed.data.PATREON_ACCESS_TOKEN,
  patreonCampaignId: parsed.data.PATREON_CAMPAIGN_ID,
  patreonClientId: parsed.data.PATREON_CLIENT_ID,
  patreonClientSecret: parsed.data.PATREON_CLIENT_SECRET,
  patreonRefreshToken: parsed.data.PATREON_REFRESH_TOKEN,
  patreonOAuthRedirectUri:
    parsed.data.PATREON_OAUTH_REDIRECT_URI || `http://localhost:${parsed.data.WEBHOOK_PORT}/oauth/callback`,
  patreonOAuthScopes: parsed.data.PATREON_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
  patreonSetupToken: parsed.data.PATREON_SETUP_TOKEN,
  patreonTierRoleMap: parseTierRoleMap(parsed.data.PATREON_TIER_ROLE_MAP),
  databasePath: parsed.data.DATABASE_PATH,
  syncIntervalMinutes: parsed.data.SYNC_INTERVAL_MINUTES,
  syncOnStart: parsed.data.SYNC_ON_START,
  dryRun: parsed.data.DRY_RUN,
  logLevel: parsed.data.LOG_LEVEL as LogLevel,
  webhookPort: parsed.data.WEBHOOK_PORT,
  patreonWebhookSecret: parsed.data.PATREON_WEBHOOK_SECRET,
  commandAllowlistRoleIds: parseCsv(parsed.data.COMMAND_ALLOWLIST_ROLE_IDS)
};
