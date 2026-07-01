import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import type { AppDatabase } from "./database";
import type { SyncService } from "./syncService";

export const patreonCommand = new SlashCommandBuilder()
  .setName("patreon")
  .setDescription("Manage Patreon member syncing")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("sync")
      .setDescription("Run a Patreon sync now")
      .addBooleanOption((option) => option.setName("dry_run").setDescription("Preview role changes without applying them"))
  )
  .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Show the latest Patreon sync status"))
  .addSubcommand((subcommand) =>
    subcommand
      .setName("member")
      .setDescription("Look up a tracked Patreon member by Discord user")
      .addUserOption((option) => option.setName("user").setDescription("Discord user").setRequired(true))
  );

interface CommandContext {
  database: AppDatabase;
  syncService: SyncService;
  allowlistRoleIds: string[];
}

export async function handlePatreonCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  if (!(await isAuthorized(interaction, context.allowlistRoleIds))) {
    await interaction.reply({
      content: "Only server administrators or allowlisted roles can use Patreon bot commands.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "sync") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dryRun = interaction.options.getBoolean("dry_run") ?? undefined;
    const result = await context.syncService.sync(`command:${interaction.user.id}`, dryRun);
    await interaction.editReply(formatSyncRun(result));
    return;
  }

  if (subcommand === "status") {
    const latest = context.database.getLatestSyncRun();
    const counts = context.database.getCounts();
    const content = latest
      ? `${formatSyncRun(latest)}\n\nTracked patrons: ${counts.patrons}\nLinked patrons: ${counts.linkedPatrons}\nActive role grants: ${counts.activeRoleGrants}`
      : "No Patreon sync has run yet.";
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === "member") {
    const user = interaction.options.getUser("user", true);
    const patron = context.database.getPatronByDiscordUserId(user.id);
    const content = patron
      ? [
          `Patreon member: ${patron.fullName ?? patron.memberId}`,
          `Status: ${patron.patronStatus ?? "unknown"}`,
          `Tiers: ${patron.tierTitles.length > 0 ? patron.tierTitles.join(", ") : "none"}`,
          `Roles: ${patron.roleIds.length > 0 ? patron.roleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "none"}`,
          `Last seen: ${patron.lastSeenAt}`
        ].join("\n")
      : `No tracked Patreon member is linked to ${user.tag}.`;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

function formatSyncRun(result: {
  status: "ok" | "error";
  finishedAt: string;
  trigger: string;
  dryRun: boolean;
  totalMembers: number;
  eligibleMembers: number;
  linkedMembers: number;
  desiredRoleGrants: number;
  rolesAdded: number;
  rolesRemoved: number;
  skipped: number;
  errors: string[];
}): string {
  const lines = [
    `Patreon sync ${result.status === "ok" ? "completed" : "finished with errors"} at ${result.finishedAt}.`,
    `Trigger: ${result.trigger}${result.dryRun ? " (dry run)" : ""}`,
    `Members: ${result.totalMembers} total, ${result.eligibleMembers} eligible, ${result.linkedMembers} linked`,
    `Role grants: ${result.desiredRoleGrants} desired, ${result.rolesAdded} added, ${result.rolesRemoved} removed, ${result.skipped} skipped`
  ];

  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.slice(0, 3).join(" | ")}`);
  }

  return lines.join("\n");
}

async function isAuthorized(interaction: ChatInputCommandInteraction, allowlistRoleIds: string[]): Promise<boolean> {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  if (allowlistRoleIds.length === 0 || !interaction.guild) {
    return false;
  }

  const member = interaction.member instanceof GuildMember ? interaction.member : await interaction.guild.members.fetch(interaction.user.id);
  return allowlistRoleIds.some((roleId) => member.roles.cache.has(roleId));
}
