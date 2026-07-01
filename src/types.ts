export type LogLevel = "debug" | "info" | "warn" | "error";

export interface PatreonTier {
  id: string;
  title: string | null;
  amountCents: number | null;
  discordRoleIds: string[];
}

export interface PatreonMember {
  id: string;
  patreonUserId: string | null;
  discordUserId: string | null;
  fullName: string | null;
  email: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeDate: string | null;
  currentlyEntitledAmountCents: number | null;
  willPayAmountCents: number | null;
  campaignLifetimeSupportCents: number | null;
  tiers: PatreonTier[];
}

export interface PatronRecord {
  memberId: string;
  patreonUserId: string | null;
  discordUserId: string | null;
  fullName: string | null;
  email: string | null;
  patronStatus: string | null;
  lastChargeStatus: string | null;
  lastChargeDate: string | null;
  currentlyEntitledAmountCents: number | null;
  willPayAmountCents: number | null;
  campaignLifetimeSupportCents: number | null;
  tierIds: string[];
  tierTitles: string[];
  roleIds: string[];
  lastSeenAt: string;
}

export interface SyncRunInput {
  startedAt: string;
  finishedAt: string;
  status: "ok" | "error";
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
  message: string | null;
}

export interface LatestSyncRun extends SyncRunInput {
  id: number;
}

export interface RoleGrant {
  discordUserId: string;
  roleId: string;
  patreonMemberId: string;
}
