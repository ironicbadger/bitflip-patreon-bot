import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AppDatabase } from "./database";
import type { Logger } from "./logger";
import type { PatreonClient } from "./patreonClient";
import type { SyncService } from "./syncService";

interface WebhookServerOptions {
  port: number;
  patreonWebhookSecret: string;
  patreonOAuthRedirectUri: string;
  patreonOAuthScopes: string[];
  patreonSetupToken: string;
}

export class WebhookServer {
  private server: Server | null = null;

  constructor(
    private readonly syncService: SyncService,
    private readonly patreonClient: PatreonClient,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly options: WebhookServerOptions
  ) {}

  start(): void {
    this.server = createServer((request, response) => {
      this.route(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("Webhook server error", { message });
        this.sendJson(response, 500, { ok: false, error: message });
      });
    });

    this.server.listen(this.options.port, () => {
      this.logger.info("Webhook server listening", { port: this.options.port });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      this.sendJson(response, 200, {
        ok: true,
        patreonReady: this.patreonClient.hasSyncConfiguration(),
        latestSync: this.database.getLatestSyncRun()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth/start") {
      this.startOAuth(request, url, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      await this.finishOAuth(url, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/webhooks/patreon") {
      const rawBody = await this.readBody(request);
      if (!this.isValidPatreonSignature(rawBody, request.headers["x-patreon-signature"])) {
        this.sendJson(response, 401, { ok: false, error: "Invalid Patreon webhook signature" });
        return;
      }

      const event = this.headerValue(request.headers["x-patreon-event"]) ?? "unknown";
      this.sendJson(response, 202, { ok: true });
      void this.syncService.sync(`webhook:${event}`).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("Webhook-triggered sync failed", { message, event });
      });
      return;
    }

    this.sendJson(response, 404, { ok: false, error: "Not found" });
  }

  private startOAuth(request: IncomingMessage, url: URL, response: ServerResponse): void {
    if (!this.isSetupAuthorized(request, url)) {
      this.sendHtml(
        response,
        401,
        "OAuth setup is locked. Set PATREON_SETUP_TOKEN and open <code>/oauth/start?setup_token=YOUR_TOKEN</code>, or run setup from localhost."
      );
      return;
    }

    if (!this.patreonClient.hasOAuthClientCredentials()) {
      this.sendHtml(
        response,
        500,
        "Patreon OAuth is not configured. Set PATREON_CLIENT_ID and PATREON_CLIENT_SECRET, then restart the bot."
      );
      return;
    }

    const state = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.database.setState("patreon_oauth_state", JSON.stringify({ state, expiresAt }));
    const authorizationUrl = this.patreonClient.buildAuthorizationUrl(
      this.options.patreonOAuthRedirectUri,
      this.options.patreonOAuthScopes,
      state
    );

    response.writeHead(302, { Location: authorizationUrl });
    response.end();
  }

  private async finishOAuth(url: URL, response: ServerResponse): Promise<void> {
    const error = url.searchParams.get("error");
    if (error) {
      this.sendHtml(response, 400, `Patreon OAuth failed: ${this.escapeHtml(error)}`);
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !this.isValidOAuthState(state)) {
      this.sendHtml(response, 400, "Invalid or expired OAuth callback state. Please start again at /oauth/start.");
      return;
    }

    await this.patreonClient.exchangeAuthorizationCode(code, this.options.patreonOAuthRedirectUri);
    this.database.setState("patreon_oauth_state", "");

    const campaigns = await this.patreonClient.fetchCampaigns();
    let campaignMessage = "";
    if (campaigns.length === 1) {
      this.patreonClient.setCampaignId(campaigns[0].id);
      campaignMessage = `Campaign ID ${this.escapeHtml(campaigns[0].id)} was saved automatically.`;
    } else if (campaigns.length > 1) {
      const list = campaigns
        .map((campaign) => `${this.escapeHtml(campaign.id)} - ${this.escapeHtml(campaign.creationName ?? "Untitled campaign")}`)
        .join("<br>");
      campaignMessage = `Multiple campaigns were found. Set PATREON_CAMPAIGN_ID to one of these, then restart:<br>${list}`;
    } else {
      campaignMessage = "No campaigns were returned. Set PATREON_CAMPAIGN_ID manually if you know it.";
    }

    this.sendHtml(
      response,
      200,
      `Patreon OAuth setup is complete. ${campaignMessage}<br><br>You can close this tab and run /patreon sync in Discord.`
    );
  }

  private isValidOAuthState(state: string): boolean {
    const raw = this.database.getState("patreon_oauth_state");
    if (!raw) {
      return false;
    }

    try {
      const parsed = JSON.parse(raw) as { state?: string; expiresAt?: number };
      return parsed.state === state && typeof parsed.expiresAt === "number" && parsed.expiresAt > Date.now();
    } catch {
      return false;
    }
  }

  private isSetupAuthorized(request: IncomingMessage, url: URL): boolean {
    const configuredToken = this.options.patreonSetupToken;
    if (!configuredToken) {
      return this.isLocalHost(url.hostname);
    }

    const providedToken = url.searchParams.get("setup_token") ?? this.headerValue(request.headers["x-setup-token"]);
    if (!providedToken) {
      return false;
    }

    const expectedBuffer = Buffer.from(configuredToken);
    const providedBuffer = Buffer.from(providedToken);
    return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
  }

  private isLocalHost(hostname: string): boolean {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  }

  private isValidPatreonSignature(rawBody: Buffer, signatureHeader: string | string[] | undefined): boolean {
    if (!this.options.patreonWebhookSecret) {
      return true;
    }

    const signature = this.headerValue(signatureHeader);
    if (!signature) {
      return false;
    }

    const expected = createHmac("md5", this.options.patreonWebhookSecret).update(rawBody).digest("hex");
    const actualBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
  }

  private sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private sendHtml(response: ServerResponse, statusCode: number, message: string): void {
    response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Patreon Discord Bot Setup</title>
  <style>
    body { background: #171717; color: #f3f3f3; font: 16px/1.5 system-ui, sans-serif; margin: 0; }
    main { max-width: 760px; margin: 12vh auto; padding: 0 24px; }
    h1 { font-size: 28px; margin: 0 0 16px; }
    p { color: #d6d6d6; }
    code { background: #2a2a2a; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Patreon Discord Bot</h1>
    <p>${message}</p>
  </main>
</body>
</html>`);
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private headerValue(value: string | string[] | undefined): string | null {
    if (!value) {
      return null;
    }
    return Array.isArray(value) ? value[0] ?? null : value;
  }
}
