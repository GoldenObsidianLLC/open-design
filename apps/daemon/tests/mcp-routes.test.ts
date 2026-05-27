import { describe, expect, it, vi } from 'vitest';
import {
  getInstallInfoRoute,
  getServersRoute,
  putServersRoute,
  postOAuthStartRoute,
  getOAuthStatusRoute,
  postOAuthDisconnectRoute,
} from '../src/mcp-routes.js';

function makeDeps(now = 1_000) {
  const installInfoStore: { cached: { t: number; payload: object } | null } = { cached: null };
  const pendingAuth = {
    put: vi.fn(),
    consume: vi.fn(),
  };
  return {
    installInfoStore,
    buildInstallPayload: vi.fn(() => ({ cli: '/usr/bin/od', port: 7456 })),
    now: () => now,
    dataDir: '/fake/data',
    templates: [{ id: 'tpl-1', label: 'Test Template' }] as any,
    readConfig: vi.fn(async () => ({
      servers: [
        {
          id: 'srv-1',
          label: 'Test Server',
          transport: 'http' as const,
          enabled: true,
          url: 'https://mcp.example.com',
        },
      ],
    })),
    writeConfig: vi.fn(async (_dir: string, _body: unknown) => ({
      servers: [{ id: 'srv-2', label: 'Updated', transport: 'stdio' as const, enabled: true }],
    })),
    getToken: vi.fn(async (_dir: string, _id: string) => null as any),
    clearToken: vi.fn(async () => {}),
    setToken: vi.fn(async () => {}),
    pendingAuth: pendingAuth as any,
    beginAuth: vi.fn(async () => ({
      authorizeUrl: 'https://auth.example.com/authorize?state=abc',
      state: 'abc',
      pending: {
        serverId: 'srv-1',
        authServerIssuer: 'https://auth.example.com',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        redirectUri: 'http://localhost:7456/api/mcp/oauth/callback',
        codeVerifier: 'verifier',
        createdAt: now,
      },
    })),
    getCallbackUrl: () => 'http://localhost:7456/api/mcp/oauth/callback',
  };
}

const EMPTY_INPUT = { body: {}, query: {}, params: {} };

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/install-info
// ─────────────────────────────────────────────────────────────────

describe('mcp — GET /api/mcp/install-info', () => {
  it('returns a fresh payload on first call', () => {
    const deps = makeDeps(1_000);
    const out = getInstallInfoRoute.handle(undefined, deps);
    expect(out).toEqual({ ok: true, value: { cli: '/usr/bin/od', port: 7456 } });
    expect(deps.buildInstallPayload).toHaveBeenCalledOnce();
    expect(deps.installInfoStore.cached).toEqual({
      t: 1_000,
      payload: { cli: '/usr/bin/od', port: 7456 },
    });
  });

  it('returns cached payload within TTL', () => {
    const deps = makeDeps(3_000);
    deps.installInfoStore.cached = { t: 1_000, payload: { cli: '/old', port: 1234 } };
    const out = getInstallInfoRoute.handle(undefined, deps);
    expect(out).toEqual({ ok: true, value: { cli: '/old', port: 1234 } });
    expect(deps.buildInstallPayload).not.toHaveBeenCalled();
  });

  it('recomputes after TTL expires', () => {
    const deps = makeDeps(10_000);
    deps.installInfoStore.cached = { t: 1_000, payload: { cli: '/old', port: 1234 } };
    const out = getInstallInfoRoute.handle(undefined, deps);
    expect(out).toEqual({ ok: true, value: { cli: '/usr/bin/od', port: 7456 } });
    expect(deps.buildInstallPayload).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/servers
// ─────────────────────────────────────────────────────────────────

describe('mcp — GET /api/mcp/servers', () => {
  it('returns servers and templates', async () => {
    const deps = makeDeps();
    const out = await getServersRoute.handle(undefined, deps);
    expect(out).toEqual({
      ok: true,
      value: {
        servers: [{ id: 'srv-1', label: 'Test Server', transport: 'http', enabled: true, url: 'https://mcp.example.com' }],
        templates: deps.templates,
      },
    });
  });

  it('returns INTERNAL_ERROR when readConfig throws', async () => {
    const deps = makeDeps();
    deps.readConfig.mockRejectedValueOnce(new Error('disk read failed'));
    const out = await getServersRoute.handle(undefined, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('INTERNAL_ERROR');
    expect(out.error.message).toBe('disk read failed');
  });
});

// ─────────────────────────────────────────────────────────────────
// PUT /api/mcp/servers
// ─────────────────────────────────────────────────────────────────

describe('mcp — PUT /api/mcp/servers', () => {
  it('passes body through and returns updated config', async () => {
    const deps = makeDeps();
    const parsed = putServersRoute.parse({ ...EMPTY_INPUT, body: { servers: [] } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = await putServersRoute.handle(parsed.value, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.servers).toEqual([{ id: 'srv-2', label: 'Updated', transport: 'stdio', enabled: true }]);
    expect(deps.writeConfig).toHaveBeenCalledWith('/fake/data', { servers: [] });
  });

  it('returns BAD_REQUEST when writeConfig throws', async () => {
    const deps = makeDeps();
    deps.writeConfig.mockRejectedValueOnce(new Error('invalid config'));
    const out = await putServersRoute.handle({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('BAD_REQUEST');
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/mcp/oauth/start
// ─────────────────────────────────────────────────────────────────

describe('mcp — POST /api/mcp/oauth/start', () => {
  it('rejects when serverId is missing', () => {
    const parsed = postOAuthStartRoute.parse({ ...EMPTY_INPUT, body: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('BAD_REQUEST');
    expect(parsed.error.message).toBe('serverId is required');
  });

  it('rejects when serverId is empty string', () => {
    const parsed = postOAuthStartRoute.parse({ ...EMPTY_INPUT, body: { serverId: '  ' } });
    expect(parsed.ok).toBe(false);
  });

  it('returns NOT_FOUND for unknown server', async () => {
    const deps = makeDeps();
    const out = await postOAuthStartRoute.handle({ serverId: 'unknown' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('NOT_FOUND');
  });

  it('rejects non-http/sse transport', async () => {
    const deps = makeDeps();
    deps.readConfig.mockResolvedValueOnce({
      servers: [{ id: 'srv-1', transport: 'stdio', enabled: true }],
    } as any);
    const out = await postOAuthStartRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('BAD_REQUEST');
    expect(out.error.message).toBe('OAuth flow only applies to http/sse transports');
  });

  it('rejects server with no URL', async () => {
    const deps = makeDeps();
    deps.readConfig.mockResolvedValueOnce({
      servers: [{ id: 'srv-1', transport: 'http', enabled: true }],
    } as any);
    const out = await postOAuthStartRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('BAD_REQUEST');
    expect(out.error.message).toBe('server has no URL configured');
  });

  it('rejects server with authMode=none', async () => {
    const deps = makeDeps();
    deps.readConfig.mockResolvedValueOnce({
      servers: [{ id: 'srv-1', transport: 'http', enabled: true, url: 'https://example.com', authMode: 'none' }],
    } as any);
    const out = await postOAuthStartRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('BAD_REQUEST');
  });

  it('starts OAuth flow and stores pending state', async () => {
    const deps = makeDeps();
    const out = await postOAuthStartRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.authorizeUrl).toBe('https://auth.example.com/authorize?state=abc');
    expect(out.value.state).toBe('abc');
    expect(out.value.redirectUri).toBe('http://localhost:7456/api/mcp/oauth/callback');
    expect(deps.pendingAuth.put).toHaveBeenCalledWith('abc', expect.objectContaining({
      serverId: 'srv-1',
    }));
  });

  it('returns UPSTREAM_UNAVAILABLE when beginAuth throws', async () => {
    const deps = makeDeps();
    deps.beginAuth.mockRejectedValueOnce(new Error('network timeout'));
    const out = await postOAuthStartRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/mcp/oauth/status
// ─────────────────────────────────────────────────────────────────

describe('mcp — GET /api/mcp/oauth/status', () => {
  it('rejects when serverId is missing', () => {
    const parsed = getOAuthStatusRoute.parse({ ...EMPTY_INPUT, query: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('BAD_REQUEST');
  });

  it('returns disconnected when no token exists', async () => {
    const deps = makeDeps();
    const out = await getOAuthStatusRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out).toEqual({ ok: true, value: { connected: false } });
  });

  it('returns connected with token details', async () => {
    const deps = makeDeps();
    deps.getToken.mockResolvedValueOnce({
      accessToken: 'tok',
      tokenType: 'Bearer',
      expiresAt: 99_000,
      scope: 'read write',
      savedAt: 50_000,
    });
    const out = await getOAuthStatusRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({
      connected: true,
      expiresAt: 99_000,
      scope: 'read write',
      savedAt: 50_000,
    });
  });

  it('returns null for missing optional token fields', async () => {
    const deps = makeDeps();
    deps.getToken.mockResolvedValueOnce({
      accessToken: 'tok',
      tokenType: 'Bearer',
      savedAt: 50_000,
    });
    const out = await getOAuthStatusRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toMatchObject({ expiresAt: null, scope: null });
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/mcp/oauth/disconnect
// ─────────────────────────────────────────────────────────────────

describe('mcp — POST /api/mcp/oauth/disconnect', () => {
  it('rejects when serverId is missing', () => {
    const parsed = postOAuthDisconnectRoute.parse({ ...EMPTY_INPUT, body: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('BAD_REQUEST');
  });

  it('clears the token and returns ok', async () => {
    const deps = makeDeps();
    const out = await postOAuthDisconnectRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out).toEqual({ ok: true, value: { ok: true } });
    expect(deps.clearToken).toHaveBeenCalledWith('/fake/data', 'srv-1');
  });

  it('returns INTERNAL_ERROR when clearToken throws', async () => {
    const deps = makeDeps();
    deps.clearToken.mockRejectedValueOnce(new Error('permission denied'));
    const out = await postOAuthDisconnectRoute.handle({ serverId: 'srv-1' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('INTERNAL_ERROR');
  });
});
