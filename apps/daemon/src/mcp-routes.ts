import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import { createApiError } from '@open-design/contracts';
import { SIDECAR_ENV } from '@open-design/sidecar-proto';
import { buildMcpInstallPayload } from './mcp-install-info.js';
import { MCP_TEMPLATES, readMcpConfig, writeMcpConfig, type McpConfig, type McpServerConfig, type McpTemplate } from './mcp-config.js';
import { beginAuth, exchangeCodeForToken, type BeginAuthInput, type BeginAuthResult, type PendingAuthCache } from './mcp-oauth.js';
import { clearToken, getToken, setToken, type StoredMcpToken } from './mcp-tokens.js';
import type { RouteDeps } from './server-context.js';
import { defineJsonRoute, err, mountJsonRoute, ok, type Result } from './http/index.js';

export interface RegisterMcpRoutesDeps extends RouteDeps<'http' | 'paths' | 'mcp'> {}

// ─────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────

const INSTALL_INFO_TTL_MS = 5000;

interface InstallInfoStore {
  cached: { t: number; payload: object } | null;
}

interface McpDomainDeps {
  installInfoStore: InstallInfoStore;
  buildInstallPayload: () => object;
  now: () => number;
  dataDir: string;
  templates: readonly McpTemplate[];
  readConfig: (dataDir: string) => Promise<McpConfig>;
  writeConfig: (dataDir: string, body: unknown) => Promise<McpConfig>;
  getToken: (dataDir: string, serverId: string) => Promise<StoredMcpToken | null>;
  clearToken: (dataDir: string, serverId: string) => Promise<void>;
  setToken: (dataDir: string, serverId: string, token: StoredMcpToken) => Promise<void>;
  pendingAuth: PendingAuthCache;
  beginAuth: (input: BeginAuthInput) => Promise<BeginAuthResult>;
  getCallbackUrl: () => string;
}

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/install-info
// ─────────────────────────────────────────────────────────────────

interface InstallInfoOutput {
  [key: string]: unknown;
}

function handleGetInstallInfo(
  _input: void,
  deps: McpDomainDeps,
): Result<InstallInfoOutput> {
  const now = deps.now();
  if (deps.installInfoStore.cached && now - deps.installInfoStore.cached.t < INSTALL_INFO_TTL_MS) {
    return ok(deps.installInfoStore.cached.payload as InstallInfoOutput);
  }
  const payload = deps.buildInstallPayload();
  deps.installInfoStore.cached = { t: now, payload };
  return ok(payload as InstallInfoOutput);
}

export const getInstallInfoRoute = defineJsonRoute<void, InstallInfoOutput, McpDomainDeps>({
  method: 'get',
  path: '/api/mcp/install-info',
  requireSameOrigin: true,
  parse: () => ok(undefined),
  handle: handleGetInstallInfo,
});

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/servers
// ─────────────────────────────────────────────────────────────────

interface GetServersOutput {
  servers: McpServerConfig[];
  templates: readonly McpTemplate[];
}

async function handleGetServers(
  _input: void,
  deps: McpDomainDeps,
): Promise<Result<GetServersOutput>> {
  try {
    const cfg = await deps.readConfig(deps.dataDir);
    return ok({ servers: cfg.servers, templates: deps.templates });
  } catch (e: any) {
    return err(createApiError('INTERNAL_ERROR', String(e?.message ?? e)));
  }
}

export const getServersRoute = defineJsonRoute<void, GetServersOutput, McpDomainDeps>({
  method: 'get',
  path: '/api/mcp/servers',
  requireSameOrigin: true,
  parse: () => ok(undefined),
  handle: handleGetServers,
});

// ─────────────────────────────────────────────────────────────────
// PUT /api/mcp/servers
// ─────────────────────────────────────────────────────────────────

type PutServersInput = unknown;

interface PutServersOutput {
  servers: McpServerConfig[];
  templates: readonly McpTemplate[];
}

function parsePutServers(raw: { body: unknown }): Result<PutServersInput> {
  return ok(raw.body);
}

async function handlePutServers(
  input: PutServersInput,
  deps: McpDomainDeps,
): Promise<Result<PutServersOutput>> {
  try {
    const cfg = await deps.writeConfig(deps.dataDir, input);
    return ok({ servers: cfg.servers, templates: deps.templates });
  } catch (e: any) {
    return err(createApiError('BAD_REQUEST', String(e?.message ?? e)));
  }
}

export const putServersRoute = defineJsonRoute<PutServersInput, PutServersOutput, McpDomainDeps>({
  method: 'put',
  path: '/api/mcp/servers',
  requireSameOrigin: true,
  parse: parsePutServers,
  handle: handlePutServers,
});

// ─────────────────────────────────────────────────────────────────
// POST /api/mcp/oauth/start
// ─────────────────────────────────────────────────────────────────

interface OAuthStartInput {
  serverId: string;
}

interface OAuthStartOutput {
  authorizeUrl: string;
  state: string;
  redirectUri: string;
}

function parseOAuthStart(raw: { body: unknown }): Result<OAuthStartInput> {
  const body = (raw.body ?? {}) as Record<string, unknown>;
  const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
  if (!serverId) {
    return err(createApiError('BAD_REQUEST', 'serverId is required'));
  }
  return ok({ serverId });
}

async function handleOAuthStart(
  input: OAuthStartInput,
  deps: McpDomainDeps,
): Promise<Result<OAuthStartOutput>> {
  try {
    const cfg = await deps.readConfig(deps.dataDir);
    const server = cfg.servers.find((s) => s.id === input.serverId);
    if (!server) {
      return err(createApiError('NOT_FOUND', `unknown serverId ${input.serverId}`));
    }
    if (server.transport !== 'http' && server.transport !== 'sse') {
      return err(createApiError('BAD_REQUEST', 'OAuth flow only applies to http/sse transports'));
    }
    if (!server.url) {
      return err(createApiError('BAD_REQUEST', 'server has no URL configured'));
    }
    if (server.authMode === 'none') {
      return err(createApiError('BAD_REQUEST', 'server is configured for no managed OAuth'));
    }
    const redirectUri = deps.getCallbackUrl();
    console.log(
      `[mcp-oauth] start serverId=${input.serverId} url=${server.url} redirect=${redirectUri}`,
    );
    const result = await deps.beginAuth({
      serverId: input.serverId,
      serverUrl: server.url,
      redirectUri,
      dataDir: deps.dataDir,
    });
    deps.pendingAuth.put(result.state, result.pending);
    console.log(
      `[mcp-oauth] start ok serverId=${input.serverId} authServer=${result.pending.authServerIssuer} clientId=${result.pending.clientId}`,
    );
    return ok({
      authorizeUrl: result.authorizeUrl,
      state: result.state,
      redirectUri,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(`[mcp-oauth] start failed serverId=${input.serverId}:`, msg);
    return err(createApiError('UPSTREAM_UNAVAILABLE', String(msg)));
  }
}

export const postOAuthStartRoute = defineJsonRoute<OAuthStartInput, OAuthStartOutput, McpDomainDeps>({
  method: 'post',
  path: '/api/mcp/oauth/start',
  requireSameOrigin: true,
  parse: parseOAuthStart,
  handle: handleOAuthStart,
});

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/oauth/status
// ─────────────────────────────────────────────────────────────────

interface OAuthStatusInput {
  serverId: string;
}

type OAuthStatusOutput =
  | { connected: false }
  | { connected: true; expiresAt: number | null; scope: string | null; savedAt: number };

function parseOAuthStatus(raw: { query: Record<string, unknown> }): Result<OAuthStatusInput> {
  const serverId = typeof raw.query.serverId === 'string' ? raw.query.serverId.trim() : '';
  if (!serverId) {
    return err(createApiError('BAD_REQUEST', 'serverId is required'));
  }
  return ok({ serverId });
}

async function handleOAuthStatus(
  input: OAuthStatusInput,
  deps: McpDomainDeps,
): Promise<Result<OAuthStatusOutput>> {
  try {
    const tok = await deps.getToken(deps.dataDir, input.serverId);
    if (!tok) return ok({ connected: false });
    return ok({
      connected: true,
      expiresAt: tok.expiresAt ?? null,
      scope: tok.scope ?? null,
      savedAt: tok.savedAt,
    });
  } catch (e: any) {
    return err(createApiError('INTERNAL_ERROR', String(e?.message ?? e)));
  }
}

export const getOAuthStatusRoute = defineJsonRoute<OAuthStatusInput, OAuthStatusOutput, McpDomainDeps>({
  method: 'get',
  path: '/api/mcp/oauth/status',
  requireSameOrigin: true,
  parse: parseOAuthStatus,
  handle: handleOAuthStatus,
});

// ─────────────────────────────────────────────────────────────────
// POST /api/mcp/oauth/disconnect
// ─────────────────────────────────────────────────────────────────

interface OAuthDisconnectInput {
  serverId: string;
}

interface OAuthDisconnectOutput {
  ok: true;
}

function parseOAuthDisconnect(raw: { body: unknown }): Result<OAuthDisconnectInput> {
  const body = (raw.body ?? {}) as Record<string, unknown>;
  const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
  if (!serverId) {
    return err(createApiError('BAD_REQUEST', 'serverId is required'));
  }
  return ok({ serverId });
}

async function handleOAuthDisconnect(
  input: OAuthDisconnectInput,
  deps: McpDomainDeps,
): Promise<Result<OAuthDisconnectOutput>> {
  try {
    await deps.clearToken(deps.dataDir, input.serverId);
    return ok({ ok: true });
  } catch (e: any) {
    return err(createApiError('INTERNAL_ERROR', String(e?.message ?? e)));
  }
}

export const postOAuthDisconnectRoute = defineJsonRoute<OAuthDisconnectInput, OAuthDisconnectOutput, McpDomainDeps>({
  method: 'post',
  path: '/api/mcp/oauth/disconnect',
  requireSameOrigin: true,
  parse: parseOAuthDisconnect,
  handle: handleOAuthDisconnect,
});

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/oauth/callback  (HTML — not a JsonRoute)
//
// Public endpoint — the OAuth provider's user-agent redirect lands
// here after the user approves. Returns HTML, not JSON, and
// deliberately does NOT enforce isLocalSameOrigin.
// ─────────────────────────────────────────────────────────────────

function registerOAuthCallbackRoute(
  app: Express,
  ctx: RegisterMcpRoutesDeps,
): void {
  const { RUNTIME_DATA_DIR } = ctx.paths;
  const { pendingAuth: pendingAuthCache } = ctx.mcp;

  app.get('/api/mcp/oauth/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const error = typeof req.query.error === 'string' ? req.query.error : '';
    if (error) {
      return res.status(400).type('html').send(renderOAuthResultPage({
        ok: false,
        message: `Auth provider returned error: ${error}`,
      }));
    }
    if (!code || !state) {
      return res.status(400).type('html').send(renderOAuthResultPage({
        ok: false,
        message: 'Missing code or state — open Settings → External MCP servers and click Connect again.',
      }));
    }
    const pending = pendingAuthCache.consume(state);
    if (!pending) {
      return res.status(400).type('html').send(renderOAuthResultPage({
        ok: false,
        message: 'Auth state expired or already used. Click Connect again.',
      }));
    }
    try {
      const tokenResp = await exchangeCodeForToken({
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        redirectUri: pending.redirectUri,
        code,
        codeVerifier: pending.codeVerifier,
        resource: pending.resourceUrl,
      });
      const stored: any = {
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token,
        tokenType: tokenResp.token_type ?? 'Bearer',
        scope: tokenResp.scope ?? pending.scope,
        expiresAt:
          typeof tokenResp.expires_in === 'number'
            ? Date.now() + tokenResp.expires_in * 1000
            : undefined,
        savedAt: Date.now(),
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        authServerIssuer: pending.authServerIssuer,
        redirectUri: pending.redirectUri,
        resourceUrl: pending.resourceUrl,
      };
      await setToken(RUNTIME_DATA_DIR, pending.serverId, stored);
      res.type('html').send(renderOAuthResultPage({
        ok: true,
        serverId: pending.serverId,
      }));
    } catch (err: any) {
      console.error(
        '[mcp-oauth] callback failed:',
        err?.message ?? err,
      );
      res.status(502).type('html').send(renderOAuthResultPage({
        ok: false,
        message: String(err?.message ?? err),
      }));
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// Route registration (call-site signature unchanged)
// ─────────────────────────────────────────────────────────────────

export function registerMcpRoutes(app: Express, ctx: RegisterMcpRoutesDeps) {
  const { resolvedPortRef } = ctx.http;
  const { OD_BIN, RUNTIME_DATA_DIR } = ctx.paths;
  const { pendingAuth: pendingAuthCache } = ctx.mcp;
  const getResolvedPort = () => resolvedPortRef.current;

  const installInfoStore: InstallInfoStore = { cached: null };

  const domainDeps: McpDomainDeps = {
    installInfoStore,
    buildInstallPayload: () => {
      const cliPath = OD_BIN;
      const sidecarIpcPath = process.env[SIDECAR_ENV.IPC_PATH];
      const isSidecarMode = sidecarIpcPath != null && sidecarIpcPath.length > 0;
      const sidecarEnv: Record<string, string> = {};
      if (isSidecarMode) {
        sidecarEnv[SIDECAR_ENV.IPC_PATH] = sidecarIpcPath;
      }
      return buildMcpInstallPayload({
        cliPath,
        cliExists: fs.existsSync(cliPath),
        execPath: process.execPath,
        nodeExists: fs.existsSync(process.execPath),
        port: getResolvedPort(),
        platform: process.platform,
        dataDir: RUNTIME_DATA_DIR,
        electronAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
        isSidecarMode,
        sidecarEnv,
      });
    },
    now: () => Date.now(),
    dataDir: RUNTIME_DATA_DIR,
    templates: MCP_TEMPLATES,
    readConfig: readMcpConfig,
    writeConfig: writeMcpConfig,
    getToken,
    clearToken,
    setToken,
    pendingAuth: pendingAuthCache,
    beginAuth,
    getCallbackUrl: () => {
      const env = process.env.OD_PUBLIC_BASE_URL;
      if (env && /^https?:\/\//i.test(env)) {
        return `${env.replace(/\/+$/u, '')}/api/mcp/oauth/callback`;
      }
      return `http://localhost:${getResolvedPort()}/api/mcp/oauth/callback`;
    },
  };

  const adapter = { resolvedPortRef };
  mountJsonRoute(app, getInstallInfoRoute, domainDeps, adapter);
  mountJsonRoute(app, getServersRoute, domainDeps, adapter);
  mountJsonRoute(app, putServersRoute, domainDeps, adapter);
  mountJsonRoute(app, postOAuthStartRoute, domainDeps, adapter);
  mountJsonRoute(app, getOAuthStatusRoute, domainDeps, adapter);
  mountJsonRoute(app, postOAuthDisconnectRoute, domainDeps, adapter);

  registerOAuthCallbackRoute(app, ctx);
}

// ─────────────────────────────────────────────────────────────────
// OAuth callback HTML helpers (used only by the callback route)
// ─────────────────────────────────────────────────────────────────

function renderOAuthResultPage(opts: any) {
  const isOk = Boolean(opts.ok);
  const title = isOk ? 'Connected' : 'Authorization failed';
  const heading = isOk ? '✅ Connected' : '⚠️ Authorization failed';
  const body = isOk
    ? `Your MCP server <code>${escapeHtml(opts.serverId ?? '')}</code> is now connected. You can close this tab and return to Open Design.`
    : escapeHtml(opts.message ?? 'Authorization could not be completed.');
  const accent = isOk ? '#1a7f37' : '#cf222e';
  const payload = isOk
    ? { type: 'mcp-oauth', ok: true, serverId: opts.serverId ?? null }
    : { type: 'mcp-oauth', ok: false, message: opts.message ?? null };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — Open Design</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif;
    background: #f6f7f9; color: #1f2328; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card { background: #161b22; border-color: #30363d; }
    code { background: #1f242c; }
  }
  .card {
    max-width: 420px; width: 100%; padding: 28px 28px 22px; border-radius: 12px;
    background: white; border: 1px solid #d0d7de; box-shadow: 0 8px 24px rgba(0,0,0,.06);
    text-align: left;
  }
  h1 { margin: 0 0 8px; font-size: 18px; color: ${accent}; }
  p  { margin: 0 0 16px; font-size: 14px; line-height: 1.55; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  button {
    appearance: none; border: 1px solid #d0d7de; background: white;
    border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #f6f8fa; }
  @media (prefers-color-scheme: dark) {
    button { background: #21262d; border-color: #30363d; color: #e6edf3; }
    button:hover { background: #30363d; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${body}</p>
    <button type="button" onclick="window.close()">Close this tab</button>
  </div>
  <script>
    try {
      var payload = ${JSON.stringify(payload)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, '*');
      }
      if (window.BroadcastChannel) {
        var bc = new BroadcastChannel('open-design-mcp-oauth');
        bc.postMessage(payload);
        bc.close();
      }
    } catch (e) { /* ignore postMessage failures */ }
  </script>
</body>
</html>`;
}

function escapeHtml(s: any) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
