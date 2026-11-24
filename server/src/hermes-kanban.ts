import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { env } from './env.js';
import { hermesEnvFor } from './engine.js';

/**
 * Hermes's own Kanban, reached from HeyZubi. The board is Hermes's: its plugin's API functions
 * (plugins/kanban/dashboard/plugin_api.py, the code behind Hermes's /api/plugins/kanban routes, which Hermes's desktop
 * board also uses) and its workflow rules (hermes_cli.kanban_workflow). HeyZubi keeps nothing of its own: every read
 * and write goes through those functions into Hermes's kanban.db, so task ids, statuses, order, events and the
 * dispatcher stay Hermes's, and a change made in either app shows in the other.
 *
 * Hermes's dashboard asks for its own sign-in, so instead of holding a dashboard credential HeyZubi runs Hermes's
 * Python once, as the Hermes user who owns the board, and calls the same functions there. One process stays up and
 * answers requests, one JSON line each way.
 */

const PLUGIN_API = '/opt/hermes/plugins/kanban/dashboard/plugin_api.py';

const WORKER = `
import contextlib, importlib.util, io, json, logging, sys
logging.disable(logging.CRITICAL)
out = sys.stdout
with contextlib.redirect_stdout(io.StringIO()):
    spec = importlib.util.spec_from_file_location("heyzubi_kanban_api", sys.argv[1])
    api = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = api  # so its request models can resolve their type names
    spec.loader.exec_module(api)
    from hermes_cli import kanban_db, kanban_workflow
    from fastapi import HTTPException
    from pydantic import ValidationError

def board_of(a):
    return a.get("board") or kanban_db.get_current_board()

def workflow(a):
    w = kanban_workflow.DEFAULT_WORKFLOW
    return {"columns": [{"key": c.key, "label": c.label, "icon": c.icon, "drag_target": bool(c.drag_target)} for c in w.columns],
            "manual": {k: list(v) for k, v in w.manual.items()}}

def cursor(a):
    with api._board_conn(board_of(a)) as (_b, conn):
        return {"latest_event_id": int(conn.execute("SELECT COALESCE(MAX(id), 0) AS m FROM task_events").fetchone()["m"])}

OPS = {
    "boards": lambda a: api.list_boards(include_archived=False),
    "workflow": workflow,
    "board": lambda a: api.get_board(tenant=None, include_archived=False, board=board_of(a), workflow_template_id=None, current_step_key=None),
    "cursor": cursor,
    "assignees": lambda a: api.get_assignees(board=board_of(a)),
    "task": lambda a: api.get_task(a["id"], board=board_of(a), run_state_type=None, run_state_name=None),
    "create": lambda a: api.create_task(api.CreateTaskBody(**a["payload"]), board=board_of(a)),
    "update": lambda a: api.update_task(a["id"], api.UpdateTaskBody(**a["payload"]), board=board_of(a)),
    "comment": lambda a: api.add_comment(a["id"], api.CommentBody(**a["payload"]), board=board_of(a)),
}

for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            op = OPS.get(req.get("op"))
            if op is None:
                raise HTTPException(status_code=400, detail="unknown operation")
            result = op(req.get("args") or {})
        msg = {"id": rid, "ok": True, "result": result}
    except HTTPException as e:
        msg = {"id": rid, "ok": False, "status": e.status_code, "error": str(e.detail)}
    except ValidationError as e:
        msg = {"id": rid, "ok": False, "status": 400, "error": "; ".join(str(x.get("msg")) for x in e.errors())}
    except Exception as e:
        msg = {"id": rid, "ok": False, "status": 500, "error": str(e) or type(e).__name__}
    out.write(json.dumps(msg, default=str) + "\\n")
    out.flush()
`;

export class KanbanError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

let proc: ChildProcess | null = null;
let buffer = '';
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function failAll(message: string) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new KanbanError(message, 503)); pending.delete(id); }
}

function worker(): ChildProcess {
  if (proc && proc.exitCode === null && !proc.killed) return proc;
  const python = path.join(path.dirname(env.hermesBin), 'python');
  const { env: runEnv, owner } = hermesEnvFor();
  const child = spawn(python, ['-u', '-c', WORKER, PLUGIN_API], {
    env: runEnv, stdio: ['pipe', 'pipe', 'pipe'], ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
  });
  buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg?.id);
      if (!p) continue;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new KanbanError(String(msg.error ?? 'Hermes refused').slice(0, 500), Number(msg.status) || 500));
    }
  });
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.on('exit', (code) => {
    if (proc === child) proc = null;
    if (pending.size) failAll(`Hermes's board stopped (${code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
  });
  child.on('error', (e) => { if (proc === child) proc = null; failAll(`Hermes's board could not start: ${e.message}`); });
  proc = child;
  return child;
}

/** Call one of Hermes's Kanban functions. Rejects with KanbanError (Hermes's own status and message). */
export function kanban<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new KanbanError('Hermes\'s board took too long to answer.', 504)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      worker().stdin!.write(JSON.stringify({ id, op, args }) + '\n');
    } catch (e: any) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new KanbanError(`Hermes's board is not reachable: ${e?.message ?? e}`, 503));
    }
  });
}
