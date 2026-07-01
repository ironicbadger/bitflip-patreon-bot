import { Client, Guild, Role, escapeMarkdown } from "discord.js";
import type { GuildBasedChannel } from "discord.js";
import type { AppDatabase } from "./database";
import type { Logger } from "./logger";
import type { PatreonClient } from "./patreonClient";
import type { PatreonMember, PatronRecord, RoleGrant, SyncRunInput } from "./types";

interface SyncServiceOptions {
  guildId: string;
  dryRun: boolean;
  tierRoleMap: Map<string, string[]>;
  manageDiscordRoles: boolean;
  announcementsEnabled: boolean;
  announcementChannelName: string;
}

interface DesiredGrant {
  discordUserId: string;
  roleId: string;
  memberId: string;
}

interface PatronAnnouncement {
  member: PatreonMember;
  content: string;
  mentionedUserIds: string[];
}

interface SendableChannel {
  send(message: { content: string; allowedMentions: { users: string[] } }): Promise<unknown>;
}

const ACTIVE_PATRON_ANNOUNCEMENT = "active_patron";
const DOUGLAS_ADAMS_QUOTES = [
  "Don't panic.",
  "Mostly harmless.",
  "Time is an illusion.",
  "Life. Don't talk to me about life.",
  "So long, and thanks for all the fish."
] as const;

export class SyncService {
  private inFlight: Promise<SyncRunInput> | null = null;

  constructor(
    private readonly client: Client,
    private readonly patreonClient: PatreonClient,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly options: SyncServiceOptions
  ) {}

  async sync(trigger: string, overrideDryRun?: boolean): Promise<SyncRunInput> {
    if (this.inFlight) {
      this.logger.info("Sync already in progress; waiting for existing run", { trigger });
      return this.inFlight;
    }

    this.inFlight = this.performSync(trigger, overrideDryRun).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async performSync(trigger: string, overrideDryRun?: boolean): Promise<SyncRunInput> {
    const startedAt = new Date().toISOString();
    const dryRun = overrideDryRun ?? this.options.dryRun;
    const errors: string[] = [];
    let totalMembers = 0;
    let eligibleMembers = 0;
    let linkedMembers = 0;
    let desiredRoleGrants = 0;
    let rolesAdded = 0;
    let rolesRemoved = 0;
    let skipped = 0;

    this.logger.info("Starting Patreon sync", { trigger, dryRun });

    try {
      const guild = await this.fetchGuild();
      const members = await this.patreonClient.fetchMembers();
      totalMembers = members.length;

      const now = new Date().toISOString();
      const hadPreviousSync = Boolean(this.database.getLatestSyncRun());
      const announcements = this.options.announcementsEnabled
        ? this.newActivePatronAnnouncements(members, hadPreviousSync)
        : [];
      const records = members.map((member) => this.toPatronRecord(member, now));
      this.database.upsertPatrons(records);

      eligibleMembers = members.filter((member) => this.isEligible(member)).length;
      linkedMembers = members.filter((member) => this.isEligible(member) && member.discordUserId).length;

      if (this.options.manageDiscordRoles) {
        const desired = this.desiredGrants(members);
        desiredRoleGrants = desired.length;

        const result = await this.applyRoleChanges(guild, desired, dryRun, errors);
        rolesAdded = result.rolesAdded;
        rolesRemoved = result.rolesRemoved;
        skipped = result.skipped;
      } else {
        this.logger.info("Discord role management disabled; leaving Patreon roles to the official Patreon bot");
      }

      await this.announceNewPatrons(guild, announcements, dryRun, errors);

      const syncRun: SyncRunInput = {
        startedAt,
        finishedAt: new Date().toISOString(),
        status: errors.length > 0 ? "error" : "ok",
        trigger,
        dryRun,
        totalMembers,
        eligibleMembers,
        linkedMembers,
        desiredRoleGrants,
        rolesAdded,
        rolesRemoved,
        skipped,
        errors,
        message: null
      };
      this.database.recordSyncRun(syncRun);
      this.logger.info("Finished Patreon sync", syncRun);
      return syncRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      const syncRun: SyncRunInput = {
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "error",
        trigger,
        dryRun,
        totalMembers,
        eligibleMembers,
        linkedMembers,
        desiredRoleGrants,
        rolesAdded,
        rolesRemoved,
        skipped,
        errors,
        message
      };
      this.database.recordSyncRun(syncRun);
      this.logger.error("Patreon sync failed", { message });
      return syncRun;
    }
  }

  private async fetchGuild(): Promise<Guild> {
    const guild = await this.client.guilds.fetch(this.options.guildId);
    if (this.options.manageDiscordRoles) {
      await guild.roles.fetch();
    }
    if (this.options.announcementsEnabled) {
      await guild.channels.fetch();
    }
    return guild;
  }

  private desiredGrants(members: PatreonMember[]): DesiredGrant[] {
    const grants = new Map<string, DesiredGrant>();

    for (const member of members) {
      if (!this.isEligible(member) || !member.discordUserId) {
        continue;
      }

      for (const roleId of this.roleIdsForMember(member)) {
        const key = `${member.discordUserId}:${roleId}`;
        grants.set(key, {
          discordUserId: member.discordUserId,
          roleId,
          memberId: member.id
        });
      }
    }

    return [...grants.values()];
  }

  private roleIdsForMember(member: PatreonMember): string[] {
    const roleIds = new Set<string>();
    for (const tier of member.tiers) {
      for (const roleId of tier.discordRoleIds) {
        roleIds.add(roleId);
      }
      for (const roleId of this.options.tierRoleMap.get(tier.id) ?? []) {
        roleIds.add(roleId);
      }
    }
    return [...roleIds];
  }

  private isEligible(member: PatreonMember): boolean {
    return member.patronStatus === "active_patron" && member.tiers.length > 0;
  }

  private isEligibleRecord(record: PatronRecord): boolean {
    return record.patronStatus === "active_patron" && record.tierIds.length > 0;
  }

  private newActivePatronAnnouncements(members: PatreonMember[], hadPreviousSync: boolean): PatronAnnouncement[] {
    const announcements: PatronAnnouncement[] = [];

    for (const member of members) {
      if (!this.isEligible(member)) {
        continue;
      }
      if (this.database.hasPatronAnnouncement(member.id, ACTIVE_PATRON_ANNOUNCEMENT)) {
        continue;
      }

      const previous = this.database.getPatronByMemberId(member.id);
      if (!previous && !hadPreviousSync) {
        continue;
      }
      if (previous && this.isEligibleRecord(previous)) {
        continue;
      }

      announcements.push(this.buildPatronAnnouncement(member));
    }

    return announcements;
  }

  private buildPatronAnnouncement(member: PatreonMember): PatronAnnouncement {
    const quote = DOUGLAS_ADAMS_QUOTES[Math.floor(Math.random() * DOUGLAS_ADAMS_QUOTES.length)];
    const tier = this.highestTierTitle(member);
    const displayName = member.discordUserId
      ? `<@${member.discordUserId}>`
      : `**${escapeMarkdown(member.fullName ?? `Patreon member ${member.id}`)}**`;
    const mentionedUserIds = member.discordUserId ? [member.discordUserId] : [];
    const content = [
      `"${quote}"`,
      "",
      `Please give a huge Bitflip thank you to ${displayName} for subscribing at **${escapeMarkdown(tier)}**.`,
      "We are massively, spectacularly grateful. Thank you, thank you, thank you."
    ].join("\n");

    return {
      member,
      content,
      mentionedUserIds
    };
  }

  private highestTierTitle(member: PatreonMember): string {
    const tier = [...member.tiers].sort((left, right) => (right.amountCents ?? 0) - (left.amountCents ?? 0))[0];
    return tier?.title ?? "a Patreon tier";
  }

  private async announceNewPatrons(
    guild: Guild,
    announcements: PatronAnnouncement[],
    dryRun: boolean,
    errors: string[]
  ): Promise<void> {
    if (!this.options.announcementsEnabled || announcements.length === 0) {
      return;
    }
    if (dryRun) {
      this.logger.info("Dry run enabled; not sending patron announcements", { announcements: announcements.length });
      return;
    }

    const channel = this.findAnnouncementChannel(guild);
    if (!channel) {
      errors.push(`Announcement channel "#${this.options.announcementChannelName}" was not found or cannot accept messages.`);
      return;
    }

    const now = new Date().toISOString();
    for (const announcement of announcements) {
      try {
        await channel.send({
          content: announcement.content,
          allowedMentions: { users: announcement.mentionedUserIds }
        });
        this.database.recordPatronAnnouncement(announcement.member.id, ACTIVE_PATRON_ANNOUNCEMENT, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Unable to announce Patreon member ${announcement.member.id}: ${message}`);
      }
    }
  }

  private findAnnouncementChannel(guild: Guild): (GuildBasedChannel & SendableChannel) | null {
    const channelName = this.normalizeChannelName(this.options.announcementChannelName);
    return (
      guild.channels.cache.find(
        (channel): channel is GuildBasedChannel & SendableChannel =>
          this.normalizeChannelName(channel.name) === channelName && channel.isTextBased() && this.isSendableChannel(channel)
      ) ?? null
    );
  }

  private normalizeChannelName(name: string): string {
    return name.replace(/^#/, "").trim().toLowerCase();
  }

  private isSendableChannel(channel: GuildBasedChannel): channel is GuildBasedChannel & SendableChannel {
    return typeof (channel as GuildBasedChannel & { send?: unknown }).send === "function";
  }

  private async applyRoleChanges(
    guild: Guild,
    desired: DesiredGrant[],
    dryRun: boolean,
    errors: string[]
  ): Promise<{ rolesAdded: number; rolesRemoved: number; skipped: number }> {
    let rolesAdded = 0;
    let rolesRemoved = 0;
    let skipped = 0;
    const now = new Date().toISOString();
    const desiredByKey = new Map(desired.map((grant) => [this.grantKey(grant.discordUserId, grant.roleId), grant]));
    const existingGrants = this.database.getActiveRoleGrants();

    for (const grant of desired) {
      const role = guild.roles.cache.get(grant.roleId);
      if (!this.canManageRole(role, errors)) {
        skipped += 1;
        continue;
      }

      try {
        const guildMember = await guild.members.fetch(grant.discordUserId);
        if (!guildMember.roles.cache.has(grant.roleId)) {
          if (!dryRun) {
            await guildMember.roles.add(grant.roleId, "Patreon membership sync");
          }
          rolesAdded += 1;
        }

        if (!dryRun) {
          this.database.markRoleGrantActive(grant.discordUserId, grant.roleId, grant.memberId, now);
        }
      } catch (error) {
        skipped += 1;
        errors.push(this.describeRoleError("add", grant, error));
      }
    }

    for (const grant of existingGrants) {
      if (desiredByKey.has(this.grantKey(grant.discordUserId, grant.roleId))) {
        const desiredGrant = desiredByKey.get(this.grantKey(grant.discordUserId, grant.roleId));
        if (!dryRun && desiredGrant) {
          this.database.markRoleGrantSeen(grant.discordUserId, grant.roleId, desiredGrant.memberId, now);
        }
        continue;
      }

      const role = guild.roles.cache.get(grant.roleId);
      if (!this.canManageRole(role, errors)) {
        skipped += 1;
        continue;
      }

      try {
        const guildMember = await guild.members.fetch(grant.discordUserId);
        if (guildMember.roles.cache.has(grant.roleId)) {
          if (!dryRun) {
            await guildMember.roles.remove(grant.roleId, "Patreon membership sync");
          }
          rolesRemoved += 1;
        }

        if (!dryRun) {
          this.database.markRoleGrantRevoked(grant.discordUserId, grant.roleId, now);
        }
      } catch (error) {
        skipped += 1;
        errors.push(this.describeRoleError("remove", grant, error));
      }
    }

    return { rolesAdded, rolesRemoved, skipped };
  }

  private canManageRole(role: Role | undefined, errors: string[]): role is Role {
    if (!role) {
      errors.push("A Patreon tier referenced a Discord role that does not exist in this guild.");
      return false;
    }
    if (!role.editable) {
      errors.push(`Bot cannot manage role "${role.name}" (${role.id}). Move the bot role above it and grant Manage Roles.`);
      return false;
    }
    return true;
  }

  private describeRoleError(action: "add" | "remove", grant: DesiredGrant | RoleGrant, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `Unable to ${action} role ${grant.roleId} for Discord user ${grant.discordUserId}: ${message}`;
  }

  private grantKey(discordUserId: string, roleId: string): string {
    return `${discordUserId}:${roleId}`;
  }

  private toPatronRecord(member: PatreonMember, now: string): PatronRecord {
    const roleIds = this.roleIdsForMember(member);
    return {
      memberId: member.id,
      patreonUserId: member.patreonUserId,
      discordUserId: member.discordUserId,
      fullName: member.fullName,
      email: member.email,
      patronStatus: member.patronStatus,
      lastChargeStatus: member.lastChargeStatus,
      lastChargeDate: member.lastChargeDate,
      currentlyEntitledAmountCents: member.currentlyEntitledAmountCents,
      willPayAmountCents: member.willPayAmountCents,
      campaignLifetimeSupportCents: member.campaignLifetimeSupportCents,
      tierIds: member.tiers.map((tier) => tier.id),
      tierTitles: member.tiers.map((tier) => tier.title ?? tier.id),
      tierAmountsCents: member.tiers.map((tier) => tier.amountCents ?? 0),
      roleIds,
      lastSeenAt: now
    };
  }
}
