import { execFile } from 'node:child_process';
import path from 'node:path';
import { env } from './env.js';
import { hermesEnvFor, hermesTarget } from './engine.js';

/**
 * A bot's Hermes profile, edited from HeyZubi with Hermes's own code: the same `profiles.describe` and
 * `profiles.configure` the Hermes desktop app's Edit Profile uses (description, SOUL.md, model, skills, toolsets, MCP
 * servers), so both apps read and write one profile under the same rules (Hermes's model-cost check included).
 *
 * The handlers live in Hermes's gateway module; HeyZubi's container has Hermes installed and the profiles mounted, so
 * a short Python run loads that module and calls the handler, as the Hermes user who owns the files.
 */

export interface ProfileSnapshot {
  name: string;
  description: string;
  soul: string;
  model: { provider: string; default: string };
  skills: { name: string; enabled: boolean }[];
  toolsets: { name: string; label: string; description: string; tool_count: number; enabled: boolean }[];
  toolsets_pinned: boolean;
  mcp_servers: { name: string; enabled: boolean; transport: string }[];
}

export interface ProfileChanges {
  description?: string;
  soul?: string;
  model?: string;
  provider?: string;
  disabled_skills?: string[];
  enabled_toolsets?: string[];
  enabled_mcp_servers?: string[];
  confirm_expensive_model?: boolean;
}

export interface ConfigureResult {
  ok?: boolean;
  applied?: Record<string, unknown>;
  confirm_required?: boolean;
  confirm_message?: string;
}

// Loads Hermes's gateway methods and calls one. Hermes prints notices while loading; the answer follows a marker.
const BRIDGE = `
import contextlib, io, json, logging, sys
logging.disable(logging.CRITICAL)
method, params = sys.argv[1], json.loads(sys.stdin.read() or "{}")
with contextlib.redirect_stdout(io.StringIO()):
    import tui_gateway.server as gateway
    handler = gateway._methods.get(method)
    reply = handler("heyzubi", params) if handler else {"error": {"message": "this Hermes has no " + method}}
sys.stdout.write("\\n@@heyzubi@@" + json.dumps(reply, default=str))
`;

const METHODS = { describe: 'profiles.describe', configure: 'profiles.configure' } as const;

function call<T>(method: keyof typeof METHODS, params: Record<string, unknown>): Promise<T> {
  const python = path.join(path.dirname(env.hermesBin), 'python');
  const { env: runEnv, owner } = hermesEnvFor();
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-c', BRIDGE, METHODS[method]], {
      env: runEnv, timeout: 90_000, maxBuffer: 16 << 20, ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
    }, (err, stdout, stderr) => {
      const at = String(stdout).lastIndexOf('@@heyzubi@@');
      if (at < 0) return reject(new Error(`Hermes did not answer${err ? `: ${(String(stderr).trim().split('\n').pop() || err.message).slice(0, 300)}` : ''}`));
      try {
        const reply = JSON.parse(String(stdout).slice(at + 11));
        if (reply?.error) return reject(new Error(String(reply.error.message ?? 'Hermes refused').slice(0, 300)));
        resolve((reply?.result ?? reply) as T);
      } catch (e: any) { reject(new Error(`Hermes's answer could not be read: ${e?.message ?? e}`)); }
    });
    child.stdin?.end(JSON.stringify(params));
  });
}

/** The bot's Hermes profile name ('default' for the main bot), or null for bots outside Hermes. */
export function profileNameFor(botId: string): string | null {
  return hermesTarget(botId)?.label ?? null;
}

export function describeProfile(botId: string): Promise<ProfileSnapshot> {
  const name = profileNameFor(botId);
  if (!name) return Promise.reject(new Error('This team member is not a Hermes profile.'));
  return call<ProfileSnapshot>('describe', { name });
}

export function configureProfile(botId: string, changes: ProfileChanges): Promise<ConfigureResult> {
  const name = profileNameFor(botId);
  if (!name) return Promise.reject(new Error('This team member is not a Hermes profile.'));
  return call<ConfigureResult>('configure', { name, ...changes });
}

/** Checks what the app sends before it reaches Hermes. Returns the clean changes, or an error message. */
export function cleanChanges(p: any): ProfileChanges | string {
  if (!p || typeof p !== 'object') return 'nothing to save';
  const out: ProfileChanges = {};
  const names = (v: unknown, what: string): string[] | string => {
    if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)) return `${what} must be a list of names`;
    return v as string[];
  };
  if (p.description !== undefined) {
    if (typeof p.description !== 'string' || p.description.length > 4000) return 'description must be text (up to 4,000 characters)';
    out.description = p.description;
  }
  if (p.soul !== undefined) {
    if (typeof p.soul !== 'string' || p.soul.length > 200_000) return 'soul must be text (up to 200,000 characters)';
    out.soul = p.soul;
  }
  if (p.model !== undefined || p.provider !== undefined) {
    const model = String(p.model ?? '').trim(), provider = String(p.provider ?? '').trim();
    if (!model || !provider || model.length > 160 || provider.length > 80) return 'model and provider are both needed';
    out.model = model; out.provider = provider;
    if (p.confirm_expensive_model === true) out.confirm_expensive_model = true;
  }
  for (const [key, what] of [['disabled_skills', 'skills'], ['enabled_toolsets', 'toolsets'], ['enabled_mcp_servers', 'MCP servers']] as const) {
    if (p[key] === undefined) continue;
    const v = names(p[key], what);
    if (typeof v === 'string') return v;
    out[key] = v;
  }
  return Object.keys(out).length ? out : 'nothing to save';
}
