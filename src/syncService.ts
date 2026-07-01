import { Client, Guild, Role } from "discord.js";
import type { AppDatabase } from "./database";
import type { Logger } from "./logger";
import type { PatreonClient } from "./patreonClient";
import type { PatreonMember, PatronRecord, RoleGrant, SyncRunInput } from "./types";

interface SyncServiceOptions {
  guildId: string;
  dryRun: boolean;
  tierRoleMap: Map<string, string[]>;
}

interface DesiredGrant {
  discordUserId: string;
  roleId: string;
  memberId: string;
}

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
      const records = members.map((member) => this.toPatronRecord(member, now));
      this.database.upsertPatrons(records);

      const desired = this.desiredGrants(members);
      eligibleMembers = members.filter((member) => this.isEligible(member)).length;
      linkedMembers = members.filter((member) => this.isEligible(member) && member.discordUserId).length;
      desiredRoleGrants = desired.length;

      const result = await this.applyRoleChanges(guild, desired, dryRun, errors);
      rolesAdded = result.rolesAdded;
      rolesRemoved = result.rolesRemoved;
      skipped = result.skipped;

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
    await guild.roles.fetch();
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
      roleIds,
      lastSeenAt: now
    };
  }
}
