import type { Bot, ComputerState, LiveState, Routine, Row, SavedPrompt, Toolkit, User } from '@shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AppsResponse { apps: Toolkit[]; connected: string[]; categories: string[]; total: number }

export interface RoomMember { id: string; name: string; label: string; description?: string; avatarShape: string; avatarColor: string; avatarProp?: string | null }

export const api = {
  me: () => req<{ user: User | null; devLogin: boolean }>('GET', '/auth/me'),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'mode'>) => req<{ bot: Bot }>('POST', '/bots', b),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${id}/rows`),
  send: (id: string, text: string, voice?: boolean) => req<{ row: Row }>('POST', `/bots/${id}/messages`, voice ? { text, voice: true } : { text }),
  interrupt: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/interrupt`),
  /** Live controls: pause after the current step, steer (pause, then carry on with a note), block or allow actions. */
  control: (id: string, action: 'pause' | 'steer' | 'block' | 'allow', text?: string) => req<{ ok: true; running?: boolean; blocked?: boolean }>('POST', `/bots/${id}/control`, { action, text }),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny') => req<{ ok: true }>('POST', `/approvals/${approvalId}`, { decision }),
  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),

  apps: (search = '', category = '') => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}`),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  /** API keys for outside programs (n8n, scripts) to message bots. */
  apiKeys: () => req<{ keys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] }>('GET', '/keys'),
  createApiKey: (name: string) => req<{ id: string; name: string; key: string }>('POST', '/keys', { name }),
  deleteApiKey: (id: string) => req<{ ok: true }>('DELETE', `/keys/${id}`),
  webhooks: () => req<{ hooks: Webhook[] }>('GET', '/webhooks'),
  createWebhook: (p: WebhookInput & { auth: 'bearer' | 'hmac' }) => req<{ hook: Webhook; secret: string }>('POST', '/webhooks', p),
  patchWebhook: (id: string, p: Partial<WebhookInput>) => req<{ hook: Webhook }>('PATCH', `/webhooks/${id}`, p),
  deleteWebhook: (id: string) => req<{ ok: true }>('DELETE', `/webhooks/${id}`),
  /** HeyZubi for Windows: paired computers and one-time pairing codes. */
  desktopDevices: () => req<{ devices: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] }>('GET', '/desktop-devices'),
  desktopPair: () => req<{ code: string; expiresAt: number }>('POST', '/desktop-devices/pair'),
  deleteDesktopDevice: (id: string) => req<{ ok: true }>('DELETE', `/desktop-devices/${id}`),
  /** Teams (from Theo): list, ready-made teams, export and import; a bot's team and manager role. */
  teams: () => req<{ teams: { name: string; managerId: string | null; memberIds: string[] }[]; ready: { key: string; team: string; blurb: string; size: number }[]; room: number }>('GET', '/teams'),
  addReadyTeam: (key: string) => req<{ bots: unknown[] }>('POST', '/teams/ready', { key }),
  exportTeam: (name: string) => req<Record<string, unknown>>('GET', `/teams/${encodeURIComponent(name)}/export`),
  importTeam: (file: unknown) => req<{ bots: unknown[] }>('POST', '/teams/import', file),
  setBotTeam: (botId: string, p: { team?: string | null; isManager?: boolean }) => req<{ bot: unknown }>('PATCH', `/bots/${botId}`, p),
  roomMembers: (id: string) => req<{ members: RoomMember[]; leadId: string | null; researchId?: string | null }>('GET', `/rooms/${id}/members`),
  setRoomLead: (id: string, botId: string | null) => req<{ ok: true; leadId: string | null }>('PUT', `/rooms/${id}/lead`, { botId }),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  setRoomResearch: (id: string, botId: string | null) => req<{ ok: true; researchId: string | null }>('PUT', `/rooms/${id}/research`, { botId }),
  prompts: (botId: string) => req<{ prompts: SavedPrompt[] }>('GET', `/prompts/${botId}`),
  addPrompt: (botId: string, title: string, text: string) => req<{ prompt: SavedPrompt }>('POST', `/prompts/${botId}`, { title, text }),
  updatePrompt: (botId: string, id: string, title: string, text: string) => req<{ prompt: SavedPrompt }>('PATCH', `/prompts/${botId}/${id}`, { title, text }),
  deletePrompt: (botId: string, id: string) => req<{ ok: true }>('DELETE', `/prompts/${botId}/${id}`),
  usedPrompt: (botId: string, id: string) => req<{ ok: true }>('POST', `/prompts/${botId}/${id}/used`),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),
};

let connectPopup: Window | null = null;

/** Open a Composio redirect in a centered popup. */
export function openPopup(url: string) {
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  connectPopup = window.open(url, 'heyzubi-connect', `width=${w},height=${h},left=${left},top=${top}`);
  return connectPopup;
}

/**
 * A tab (or the connect popup) for a link that has to be fetched first. In a browser it opens empty at once, or it would
 * be blocked as a pop-up. The Windows app sends links to the PC's browser and can't open an empty one, so there the link
 * itself is opened when it's known.
 */
export function openWhenReady(popup = false) {
  const desktopApp = !!(window as { chrome?: { webview?: unknown } }).chrome?.webview;
  const w = desktopApp ? null : popup ? openPopup('about:blank') : window.open('about:blank', '_blank');
  return {
    go(url: string) {
      if (!w) { window.open(url, '_blank', popup ? undefined : 'noopener'); return; }
      if (!popup) w.opener = null;
      w.location.href = url;
    },
    close() { w?.close(); },
  };
}

/** The "app connected" note from our OAuth callback page: it must come from the popup we opened or from this app's own origin. */
export function isConnectedMessage(e: MessageEvent): boolean {
  if ((e.data as { type?: string } | null)?.type !== 'heyzubi-connected') return false;
  return e.origin === window.location.origin || (connectPopup !== null && e.source === connectPopup);
}

export interface WebhookInput { name: string; bot: string | null; trust: 'approve' | 'allow'; required: string[]; prompt: string }
export interface Webhook extends WebhookInput { id: string; auth: 'bearer' | 'hmac'; createdAt: number; lastUsedAt: number | null; path: string }
