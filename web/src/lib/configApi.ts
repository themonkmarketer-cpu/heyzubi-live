import type { Bot, ComputerState, EngineInfo, LibraryFile, Memory, Routine, Skill, Task, Toolkit } from '@shared/types';
import { ApiError } from './api';

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
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; files: LibraryFile[]; error?: string; /** Files can be shown in the browser (Open). */ canOpen?: boolean }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
}

/** What Hermes's own Edit Profile shows for a profile (server/src/hermes-profile.ts ProfileSnapshot). */
export interface HermesProfile {
  name: string;
  description: string;
  soul: string;
  model: { provider: string; default: string };
  skills: { name: string; enabled: boolean }[];
  toolsets: { name: string; label: string; description: string; tool_count: number; enabled: boolean }[];
  toolsets_pinned: boolean;
  mcp_servers: { name: string; enabled: boolean; transport: string }[];
}
export interface HermesProfileChanges {
  description?: string; soul?: string; model?: string; provider?: string;
  disabled_skills?: string[]; enabled_toolsets?: string[]; enabled_mcp_servers?: string[]; confirm_expensive_model?: boolean;
}

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'avatarProp' | 'effort' | 'mode'>>;

export interface AgentSkill { path: string; name: string; description: string; category: string; updated: number; size: number; secretLike: boolean }

export const configApi = {
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  /** The bot's Hermes profile, read and saved through Hermes itself (null: not a Hermes profile). */
  profile: (botId: string) => req<{ profile: HermesProfile | null }>('GET', `/bots/${botId}/profile`),
  saveProfile: (botId: string, p: HermesProfileChanges) =>
    req<{ ok: boolean; failed: string[]; profile: HermesProfile } | { confirmRequired: true; message: string }>('PUT', `/bots/${botId}/profile`, p),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  makePrimary: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/primary`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),

  createSkill: (botId: string, s: Pick<Skill, 'name' | 'description' | 'body'>) => req<{ skill: Skill }>('POST', `/bots/${botId}/skills`, s),
  /** Skills the agent saved itself in its engine (read-only). */
  agentSkills: (botId: string) => req<{ skills: AgentSkill[] }>('GET', `/bots/${botId}/agent-skills`),
  agentSkill: (botId: string, path: string) => req<{ path: string; content: string }>('GET', `/bots/${botId}/agent-skills/view?path=${encodeURIComponent(path)}`),
  updateSkill: (id: string, s: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => req<{ skill: Skill }>('PATCH', `/skills/${id}`, s),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skills/${id}`),

  /** Every routine on the team (Routines view). */
  allRoutines: () => req<{ routines: Routine[] }>('GET', '/routines'),
  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
  /** Tells the bot the person has stopped driving its screen. */
  handback: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/handback`),

  engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
  setEngine: (botId: string, p: { provider?: string | null; model?: string | null }) => req<{ engine: EngineInfo }>('PATCH', `/bots/${botId}/engine`, p),
  /** Opens the provider's sign-in flow in a terminal on the bot's screen. */
  engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
  /** Claude sign-in in the owner's own browser (team members): get the link, then send back the code Claude shows. */
  claudeSignInStart: (botId: string) => req<{ url: string }>('POST', `/bots/${botId}/engine/signin/start`),
  claudeSignInFinish: (botId: string, code: string) => req<{ ok: true; engine?: EngineInfo }>('POST', `/bots/${botId}/engine/signin/finish`, { code }),
  claudeSignInCancel: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/signin/cancel`),
  restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private screen the agent runs for itself, so its computer work shows on the screen in the app. */
  stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[] }>('GET', '/apps?limit=1'),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};
