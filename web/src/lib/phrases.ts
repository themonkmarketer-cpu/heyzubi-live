import type { ActivityKind, LiveState, Row } from '@shared/types';

/** Activity kind → status phrases for the live activity line. Multi-phrase kinds rotate. */
const PHRASES: Record<string, string[]> = {
  thinking: ['Working out a plan', 'Weighing the options', 'Connecting the dots'],
  working: ['On the task', 'Moving things along', 'Busy with it', 'Taking care of it', 'Making headway'],
  searching_web: ['Searching the web'],
  reading_web: ['Reading up on it'],
  browsing_web: ['Browsing a few sites'],
  drafting_file: ['Writing a draft'],
  on_its_computer: ['Using its computer'],
  running_commands: ['Running commands'],
  waiting_on_command: ['Waiting for output'],
  waiting_for_you: ['Waiting for your reply'],
  remembering: ['Saving that for later'],
};

const nice = (s?: string) => !!s && !/[_]/.test(s) && !/^[a-z0-9-]+$/.test(s);

/** Name of the bot being messaged: the running call's `bot_name` argument, else a readable `detail`. */
function messagedName(live: LiveState, rows: Row[]): string | null {
  const running = [...rows].reverse().find((r) => r.body.type === 'tool-call' && r.body.status === 'running');
  const args = running?.body.type === 'tool-call' ? (running.body.args as Record<string, unknown> | undefined) : undefined;
  if (typeof args?.bot_name === 'string') return args.bot_name;
  return nice(live.activity?.detail) ? live.activity!.detail! : null;
}

/** Phrase for the live caption when the server sent none. `tick` rotates multi-phrase kinds. */
export function activityPhrase(live: LiveState, rows: Row[], tick: number): string {
  const a = live.activity;
  if (!a) return live.awaiting ? 'Waiting for your reply' : 'On the task';
  const kind = a.kind as ActivityKind;
  if (kind === 'messaging_named') {
    const name = messagedName(live, rows);
    return name ? `Asking ${name}` : 'Asking someone on the team';
  }
  if (kind === 'connecting_service') return nice(a.detail) ? `Using ${a.detail}` : 'Using a connected app';
  const list = PHRASES[kind] ?? PHRASES.working;
  return list[tick % list.length];
}

/** One or two words for the status pill under the bot's name. */
const STATUS: Record<ActivityKind, string> = {
  thinking: 'Thinking',
  working: 'Working',
  searching_web: 'Searching',
  reading_web: 'Reading',
  browsing_web: 'Browsing',
  on_its_computer: 'On its computer',
  running_commands: 'Running commands',
  waiting_on_command: 'Waiting on results',
  messaging_named: 'Checking in',
  connecting_service: 'Using an app',
  waiting_for_you: 'Needs you',
  drafting_file: 'Writing',
  remembering: 'Remembering',
};

/** True when the bot has stopped to wait for the person (approval, question, connect). */
export function isWaitingForYou(live: LiveState | undefined): boolean {
  return !!live && (!!live.awaiting || live.activity?.kind === 'waiting_for_you');
}

/** Short status word for the pill: "Thinking", "Browsing", "Working in Gmail", "Needs you". */
export function activityStatus(live: LiveState, rows: Row[]): string {
  if (isWaitingForYou(live)) return 'Needs you';
  const a = live.activity;
  if (!a) return 'Thinking';
  if (a.kind === 'messaging_named') {
    const name = messagedName(live, rows);
    return name ? `Checking with ${name}` : STATUS.messaging_named;
  }
  if (a.kind === 'connecting_service') return nice(a.detail) ? `Working in ${a.detail}` : STATUS.connecting_service;
  return STATUS[a.kind] ?? 'Working';
}
