import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { LatestSyncRun, PatronRecord, RoleGrant, SyncRunInput } from "./types";

interface PatronRow {
  member_id: string;
  patreon_user_id: string | null;
  discord_user_id: string | null;
  full_name: string | null;
  email: string | null;
  patron_status: string | null;
  last_charge_status: string | null;
  last_charge_date: string | null;
  currently_entitled_amount_cents: number | null;
  will_pay_amount_cents: number | null;
  campaign_lifetime_support_cents: number | null;
  tier_ids_json: string;
  tier_titles_json: string;
  role_ids_json: string;
  last_seen_at: string;
}

interface RoleGrantRow {
  discord_user_id: string;
  role_id: string;
  patreon_member_id: string;
}

interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string;
  status: "ok" | "error";
  trigger_source: string;
  dry_run: 0 | 1;
  total_members: number;
  eligible_members: number;
  linked_members: number;
  desired_role_grants: number;
  roles_added: number;
  roles_removed: number;
  skipped: number;
  errors_json: string;
  message: string | null;
}

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertPatrons(records: PatronRecord[]): void {
    const statement = this.db.prepare(`
      INSERT INTO patrons (
        member_id,
        patreon_user_id,
        discord_user_id,
        full_name,
        email,
        patron_status,
        last_charge_status,
        last_charge_date,
        currently_entitled_amount_cents,
        will_pay_amount_cents,
        campaign_lifetime_support_cents,
        tier_ids_json,
        tier_titles_json,
        role_ids_json,
        last_seen_at,
        updated_at
      )
      VALUES (
        @memberId,
        @patreonUserId,
        @discordUserId,
        @fullName,
        @email,
        @patronStatus,
        @lastChargeStatus,
        @lastChargeDate,
        @currentlyEntitledAmountCents,
        @willPayAmountCents,
        @campaignLifetimeSupportCents,
        @tierIdsJson,
        @tierTitlesJson,
        @roleIdsJson,
        @lastSeenAt,
        @updatedAt
      )
      ON CONFLICT(member_id) DO UPDATE SET
        patreon_user_id = excluded.patreon_user_id,
        discord_user_id = excluded.discord_user_id,
        full_name = excluded.full_name,
        email = excluded.email,
        patron_status = excluded.patron_status,
        last_charge_status = excluded.last_charge_status,
        last_charge_date = excluded.last_charge_date,
        currently_entitled_amount_cents = excluded.currently_entitled_amount_cents,
        will_pay_amount_cents = excluded.will_pay_amount_cents,
        campaign_lifetime_support_cents = excluded.campaign_lifetime_support_cents,
        tier_ids_json = excluded.tier_ids_json,
        tier_titles_json = excluded.tier_titles_json,
        role_ids_json = excluded.role_ids_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);

    const insertMany = this.db.transaction((items: PatronRecord[]) => {
      for (const record of items) {
        statement.run({
          ...record,
          tierIdsJson: JSON.stringify(record.tierIds),
          tierTitlesJson: JSON.stringify(record.tierTitles),
          roleIdsJson: JSON.stringify(record.roleIds),
          updatedAt: new Date().toISOString()
        });
      }
    });

    insertMany(records);
  }

  getPatronByDiscordUserId(discordUserId: string): PatronRecord | null {
    const row = this.db
      .prepare("SELECT * FROM patrons WHERE discord_user_id = ? ORDER BY last_seen_at DESC LIMIT 1")
      .get(discordUserId) as PatronRow | undefined;
    return row ? this.patronFromRow(row) : null;
  }

  getActiveRoleGrants(): RoleGrant[] {
    const rows = this.db
      .prepare("SELECT discord_user_id, role_id, patreon_member_id FROM role_grants WHERE active = 1")
      .all() as RoleGrantRow[];
    return rows.map((row) => ({
      discordUserId: row.discord_user_id,
      roleId: row.role_id,
      patreonMemberId: row.patreon_member_id
    }));
  }

  markRoleGrantActive(discordUserId: string, roleId: string, patreonMemberId: string, now: string): void {
    this.db
      .prepare(`
        INSERT INTO role_grants (
          discord_user_id,
          role_id,
          patreon_member_id,
          active,
          granted_at,
          revoked_at,
          last_seen_at
        )
        VALUES (?, ?, ?, 1, ?, NULL, ?)
        ON CONFLICT(discord_user_id, role_id) DO UPDATE SET
          patreon_member_id = excluded.patreon_member_id,
          active = 1,
          revoked_at = NULL,
          last_seen_at = excluded.last_seen_at
      `)
      .run(discordUserId, roleId, patreonMemberId, now, now);
  }

  markRoleGrantSeen(discordUserId: string, roleId: string, patreonMemberId: string, now: string): void {
    this.db
      .prepare(`
        UPDATE role_grants
        SET patreon_member_id = ?, last_seen_at = ?, active = 1, revoked_at = NULL
        WHERE discord_user_id = ? AND role_id = ?
      `)
      .run(patreonMemberId, now, discordUserId, roleId);
  }

  markRoleGrantRevoked(discordUserId: string, roleId: string, now: string): void {
    this.db
      .prepare(`
        UPDATE role_grants
        SET active = 0, revoked_at = ?, last_seen_at = ?
        WHERE discord_user_id = ? AND role_id = ?
      `)
      .run(now, now, discordUserId, roleId);
  }

  recordSyncRun(input: SyncRunInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO sync_runs (
          started_at,
          finished_at,
          status,
          trigger_source,
          dry_run,
          total_members,
          eligible_members,
          linked_members,
          desired_role_grants,
          roles_added,
          roles_removed,
          skipped,
          errors_json,
          message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.startedAt,
        input.finishedAt,
        input.status,
        input.trigger,
        input.dryRun ? 1 : 0,
        input.totalMembers,
        input.eligibleMembers,
        input.linkedMembers,
        input.desiredRoleGrants,
        input.rolesAdded,
        input.rolesRemoved,
        input.skipped,
        JSON.stringify(input.errors),
        input.message
      );
    return Number(result.lastInsertRowid);
  }

  getLatestSyncRun(): LatestSyncRun | null {
    const row = this.db
      .prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1")
      .get() as SyncRunRow | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      trigger: row.trigger_source,
      dryRun: row.dry_run === 1,
      totalMembers: row.total_members,
      eligibleMembers: row.eligible_members,
      linkedMembers: row.linked_members,
      desiredRoleGrants: row.desired_role_grants,
      rolesAdded: row.roles_added,
      rolesRemoved: row.roles_removed,
      skipped: row.skipped,
      errors: JSON.parse(row.errors_json) as string[],
      message: row.message
    };
  }

  getCounts(): { patrons: number; linkedPatrons: number; activeRoleGrants: number } {
    const row = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM patrons) AS patrons,
          (SELECT COUNT(*) FROM patrons WHERE discord_user_id IS NOT NULL) AS linkedPatrons,
          (SELECT COUNT(*) FROM role_grants WHERE active = 1) AS activeRoleGrants
      `)
      .get() as { patrons: number; linkedPatrons: number; activeRoleGrants: number };
    return row;
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string, now = new Date().toISOString()): void {
    this.db
      .prepare(`
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, now);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patrons (
        member_id TEXT PRIMARY KEY,
        patreon_user_id TEXT,
        discord_user_id TEXT,
        full_name TEXT,
        email TEXT,
        patron_status TEXT,
        last_charge_status TEXT,
        last_charge_date TEXT,
        currently_entitled_amount_cents INTEGER,
        will_pay_amount_cents INTEGER,
        campaign_lifetime_support_cents INTEGER,
        tier_ids_json TEXT NOT NULL DEFAULT '[]',
        tier_titles_json TEXT NOT NULL DEFAULT '[]',
        role_ids_json TEXT NOT NULL DEFAULT '[]',
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_patrons_discord_user_id
        ON patrons(discord_user_id);

      CREATE TABLE IF NOT EXISTS role_grants (
        discord_user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        patreon_member_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(discord_user_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        total_members INTEGER NOT NULL DEFAULT 0,
        eligible_members INTEGER NOT NULL DEFAULT 0,
        linked_members INTEGER NOT NULL DEFAULT 0,
        desired_role_grants INTEGER NOT NULL DEFAULT 0,
        roles_added INTEGER NOT NULL DEFAULT 0,
        roles_removed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]',
        message TEXT
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private patronFromRow(row: PatronRow): PatronRecord {
    return {
      memberId: row.member_id,
      patreonUserId: row.patreon_user_id,
      discordUserId: row.discord_user_id,
      fullName: row.full_name,
      email: row.email,
      patronStatus: row.patron_status,
      lastChargeStatus: row.last_charge_status,
      lastChargeDate: row.last_charge_date,
      currentlyEntitledAmountCents: row.currently_entitled_amount_cents,
      willPayAmountCents: row.will_pay_amount_cents,
      campaignLifetimeSupportCents: row.campaign_lifetime_support_cents,
      tierIds: JSON.parse(row.tier_ids_json) as string[],
      tierTitles: JSON.parse(row.tier_titles_json) as string[],
      roleIds: JSON.parse(row.role_ids_json) as string[],
      lastSeenAt: row.last_seen_at
    };
  }
}
