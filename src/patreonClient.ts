import type { AppDatabase } from "./database";
import type { Logger } from "./logger";
import type { PatreonMember, PatreonTier } from "./types";

interface PatreonResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: PatreonRelationship | PatreonRelationship[] | null }>;
}

interface PatreonRelationship {
  id: string;
  type: string;
}

interface PatreonListResponse {
  data: PatreonResource[];
  included?: PatreonResource[];
  links?: {
    next?: string | null;
  };
  meta?: {
    pagination?: {
      cursors?: {
        next?: string | null;
      };
    };
  };
}

interface PatreonTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface PatreonClientOptions {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  campaignId: string;
}

export interface PatreonCampaign {
  id: string;
  creationName: string | null;
  summary: string | null;
  patronCount: number | null;
}

const PATREON_API_BASE = "https://www.patreon.com/api/oauth2/v2";
const PATREON_AUTHORIZE_URL = "https://www.patreon.com/oauth2/authorize";
const PATREON_TOKEN_URL = "https://www.patreon.com/api/oauth2/token";

export class PatreonClient {
  private accessToken: string;
  private refreshToken: string;
  private campaignId: string;

  constructor(
    private readonly options: PatreonClientOptions,
    private readonly database: AppDatabase,
    private readonly logger: Logger
  ) {
    this.accessToken = database.getState("patreon_access_token") ?? options.accessToken;
    this.refreshToken = database.getState("patreon_refresh_token") ?? options.refreshToken;
    this.campaignId = database.getState("patreon_campaign_id") ?? options.campaignId;
  }

  hasOAuthClientCredentials(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  hasSyncConfiguration(): boolean {
    return Boolean(this.accessToken && this.campaignId);
  }

  buildAuthorizationUrl(redirectUri: string, scopes: string[], state: string): string {
    if (!this.options.clientId) {
      throw new Error("PATREON_CLIENT_ID is required to start OAuth setup.");
    }

    const url = new URL(PATREON_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<void> {
    if (!this.hasOAuthClientCredentials()) {
      throw new Error("PATREON_CLIENT_ID and PATREON_CLIENT_SECRET are required to exchange an OAuth code.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret
    });

    const response = await fetch(PATREON_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "patreon-discord-bot/0.1"
      },
      body
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Unable to exchange Patreon OAuth code (${response.status}): ${errorBody.slice(0, 500)}`);
    }

    const token = (await response.json()) as PatreonTokenResponse;
    this.storeTokenResponse(token);
  }

  async fetchCampaigns(): Promise<PatreonCampaign[]> {
    const url = new URL(`${PATREON_API_BASE}/campaigns`);
    url.searchParams.set("fields[campaign]", ["creation_name", "summary", "patron_count"].join(","));
    const response = await this.requestPatreon<PatreonListResponse>(url.toString());
    return response.data.map((campaign) => ({
      id: campaign.id,
      creationName: this.stringAttribute(campaign.attributes, "creation_name"),
      summary: this.stringAttribute(campaign.attributes, "summary"),
      patronCount: this.numberAttribute(campaign.attributes, "patron_count")
    }));
  }

  setCampaignId(campaignId: string): void {
    this.campaignId = campaignId;
    this.database.setState("patreon_campaign_id", campaignId);
  }

  async fetchMembers(): Promise<PatreonMember[]> {
    if (!this.accessToken) {
      throw new Error("Missing Patreon access token. Add PATREON_ACCESS_TOKEN or complete OAuth setup at /oauth/start.");
    }
    if (!this.campaignId) {
      throw new Error("Missing Patreon campaign ID. Add PATREON_CAMPAIGN_ID or complete OAuth setup at /oauth/start.");
    }

    const members: PatreonMember[] = [];
    let cursor: string | null = null;

    do {
      const url = this.buildMembersUrl(cursor);
      const page = await this.requestPatreon<PatreonListResponse>(url);
      members.push(...this.normalizeMembers(page));
      cursor = page.meta?.pagination?.cursors?.next ?? this.cursorFromNextLink(page.links?.next) ?? null;
    } while (cursor);

    return members;
  }

  private buildMembersUrl(cursor: string | null): string {
    const url = new URL(`${PATREON_API_BASE}/campaigns/${this.campaignId}/members`);
    url.searchParams.set(
      "fields[member]",
      [
        "full_name",
        "email",
        "patron_status",
        "last_charge_status",
        "last_charge_date",
        "currently_entitled_amount_cents",
        "will_pay_amount_cents",
        "campaign_lifetime_support_cents"
      ].join(",")
    );
    url.searchParams.set("fields[tier]", ["title", "amount_cents", "discord_role_ids"].join(","));
    url.searchParams.set("fields[user]", ["full_name", "email", "social_connections", "url", "vanity"].join(","));
    url.searchParams.set("include", "currently_entitled_tiers,user");
    url.searchParams.set("page[count]", "1000");
    if (cursor) {
      url.searchParams.set("page[cursor]", cursor);
    }
    return url.toString();
  }

  private async requestPatreon<T>(url: string, hasRetried = false): Promise<T> {
    if (!this.accessToken) {
      throw new Error("Missing Patreon access token.");
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": "patreon-discord-bot/0.1"
      }
    });

    if (response.status === 401 && !hasRetried && this.canRefreshToken()) {
      await this.refreshAccessToken();
      return this.requestPatreon<T>(url, true);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Patreon API request failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`);
    }

    return (await response.json()) as T;
  }

  private canRefreshToken(): boolean {
    return Boolean(this.refreshToken && this.options.clientId && this.options.clientSecret);
  }

  private async refreshAccessToken(): Promise<void> {
    this.logger.info("Refreshing Patreon access token");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret
    });

    const response = await fetch(PATREON_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "patreon-discord-bot/0.1"
      },
      body
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Unable to refresh Patreon token (${response.status}): ${errorBody.slice(0, 500)}`);
    }

    const token = (await response.json()) as PatreonTokenResponse;
    this.storeTokenResponse(token);
  }

  private storeTokenResponse(token: PatreonTokenResponse): void {
    this.accessToken = token.access_token;
    this.database.setState("patreon_access_token", token.access_token);

    if (token.refresh_token) {
      this.refreshToken = token.refresh_token;
      this.database.setState("patreon_refresh_token", token.refresh_token);
    }

    if (token.expires_in) {
      const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
      this.database.setState("patreon_access_token_expires_at", expiresAt);
    }
  }

  private normalizeMembers(response: PatreonListResponse): PatreonMember[] {
    const includedByKey = new Map<string, PatreonResource>();
    for (const resource of response.included ?? []) {
      includedByKey.set(`${resource.type}:${resource.id}`, resource);
    }

    return response.data.map((member) => {
      const userRelationship = this.singleRelationship(member.relationships?.user?.data);
      const user = userRelationship ? includedByKey.get(`${userRelationship.type}:${userRelationship.id}`) : undefined;
      const tierRelationships = this.manyRelationships(member.relationships?.currently_entitled_tiers?.data);
      const tiers = tierRelationships
        .map((relationship) => includedByKey.get(`${relationship.type}:${relationship.id}`))
        .filter((resource): resource is PatreonResource => Boolean(resource))
        .map((tier) => this.normalizeTier(tier));

      return {
        id: member.id,
        patreonUserId: userRelationship?.id ?? null,
        discordUserId: this.extractDiscordUserId(user?.attributes?.social_connections),
        fullName: this.stringAttribute(member.attributes, "full_name") ?? this.stringAttribute(user?.attributes, "full_name"),
        email: this.stringAttribute(member.attributes, "email") ?? this.stringAttribute(user?.attributes, "email"),
        patronStatus: this.stringAttribute(member.attributes, "patron_status"),
        lastChargeStatus: this.stringAttribute(member.attributes, "last_charge_status"),
        lastChargeDate: this.stringAttribute(member.attributes, "last_charge_date"),
        currentlyEntitledAmountCents: this.numberAttribute(member.attributes, "currently_entitled_amount_cents"),
        willPayAmountCents: this.numberAttribute(member.attributes, "will_pay_amount_cents"),
        campaignLifetimeSupportCents: this.numberAttribute(member.attributes, "campaign_lifetime_support_cents"),
        tiers
      };
    });
  }

  private normalizeTier(resource: PatreonResource): PatreonTier {
    return {
      id: resource.id,
      title: this.stringAttribute(resource.attributes, "title"),
      amountCents: this.numberAttribute(resource.attributes, "amount_cents"),
      discordRoleIds: this.stringArrayAttribute(resource.attributes, "discord_role_ids")
    };
  }

  private singleRelationship(value: PatreonRelationship | PatreonRelationship[] | null | undefined): PatreonRelationship | null {
    if (!value) {
      return null;
    }
    return Array.isArray(value) ? value[0] ?? null : value;
  }

  private manyRelationships(value: PatreonRelationship | PatreonRelationship[] | null | undefined): PatreonRelationship[] {
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  private stringAttribute(attributes: Record<string, unknown> | undefined, key: string): string | null {
    const value = attributes?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private numberAttribute(attributes: Record<string, unknown> | undefined, key: string): number | null {
    const value = attributes?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private stringArrayAttribute(attributes: Record<string, unknown> | undefined, key: string): string[] {
    const value = attributes?.[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  private extractDiscordUserId(value: unknown): string | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const socialConnections = value as Record<string, unknown>;
    const discord = socialConnections.discord;
    if (!discord || typeof discord !== "object") {
      return null;
    }

    const discordConnection = discord as Record<string, unknown>;
    const userId = discordConnection.user_id ?? discordConnection.userId ?? discordConnection.id;
    return typeof userId === "string" && userId.length > 0 ? userId : null;
  }

  private cursorFromNextLink(link: string | null | undefined): string | null {
    if (!link) {
      return null;
    }
    try {
      return new URL(link).searchParams.get("page[cursor]");
    } catch {
      return null;
    }
  }
}
