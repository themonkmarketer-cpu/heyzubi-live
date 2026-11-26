// Shared API contract between server and web (web imports these as types only).

export type AvatarShape =
  | 'blob' | 'pebble' | 'bean' | 'egg' | 'squircle' | 'tablet' | 'capsule' | 'cylinder' | 'hex'
  | 'gem' | 'crystal' | 'wedge' | 'shield' | 'dome' | 'arch' | 'cloud' | 'teardrop' | 'leaf'
  | 'square' | 'sparkle' | 'clover' | 'flower' | 'heart' | 'house' | 'star';

export type AvatarColor =
  | 'black' | 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'lime' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'gray';

export interface User { id: string; email: string; name: string; avatarUrl: string | null; /** Shown in the account row instead of name (prefs). */ displayName?: string | null }

export interface Bot {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  /** The prop in its avatar (avatar-props.ts): a prop id, 'none', or null = picked from its role. */
  avatarProp: string | null;
  /** Its Hermes profile ('default' for the main bot), or null when its agent is not a Hermes profile. */
  hermesProfile?: string | null;
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  /** 'room' = group chat (members answer instead of the bot itself). */
  kind?: 'agent' | 'room';
  pinned: boolean;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /** Voice chat settings: xAI voice id, speed multiplier (0.7–1.5), BCP-47 language or 'auto'. */
  voice: string;
  voiceSpeed: number;
  voiceLanguage: string;
  /** Which engine runs live calls (picked under Voice chat), and the voice used on Gemini. */
  voiceEngine: VoiceEngine;
  geminiVoice: string;
  /** Who transcribes voice messages and reads replies aloud: xAI, or Sarvam (Hindi / Hinglish), and its voice. */
  voiceMsgEngine: 'xai' | 'sarvam';
  sarvamVoice: string;
  /** Team (from Theo): the team this bot is on, and whether it manages it. The primary bot is the CEO. */
  team: string | null;
  isManager: boolean;
  /** Hermes engine: model id and provider for this bot; null = the engine's default. */
  model: string | null;
  provider: string | null;
  generation: number;
  unread: number;
  lastPreview: string | null;
  lastActivityAt: number;
  createdAt: number;
}

/** A transcript row. `seq` orders rows; `updatedSeq` is a per-bot revision counter (rows are rewritten while streaming). */
export interface Row {
  botId: string;
  generation: number;
  seq: number;
  updatedSeq: number;
  kind: RowKind;
  body: RowBody;
  createdAt: number;
}

export type RowKind = 'message' | 'tool-call' | 'card' | 'event' | 'notice';

export type RowBody =
  | MessageBody
  | ToolCallBody
  | CardBody
  | EventBody
  | NoticeBody;

export interface MessageBody {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /** Set when a message came from another bot, a routine or a voice call rather than the user typing. */
  /** steer: the owner's note sent while the bot was working (it pauses after its step and carries on with it). */
  from?: { kind: 'bot' | 'routine' | 'voice' | 'program' | 'steer'; id: string; name: string };
  citations?: { url: string; title?: string }[];
}

export interface ToolCallBody {
  type: 'tool-call';
  callId: string;
  name: string;
  /** Human phrase, e.g. "Clicking on screen". */
  label: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'denied';
  args?: unknown;
  summary?: string;
  /** Data URL thumbnail for computer actions. */
  screenshot?: string;
}

export type CardBody =
  | {
      type: 'card';
      card: 'approval';
      approvalId: string;
      title: string;
      detail: string;
      tool: string;
      /** Every tool this card asks about; "Always allow" covers exactly these. Absent on older cards. */
      tools?: string[];
      toolkit?: string;
      toolkitName?: string;
      logo?: string;
      args: unknown;
      status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired';
    }
  | {
      type: 'card';
      card: 'question';
      question: string;
      options: string[];
      /** Show an "Other" choice with a box for the owner's own words. */
      other?: boolean;
      status: 'pending' | 'answered' | 'dismissed';
      answer?: string;
    }
  | {
      type: 'card';
      card: 'connect';
      toolkit: string;
      toolkitName: string;
      logo?: string;
      reason: string;
      status: 'pending' | 'connected' | 'skipped';
    }
  | {
      /** A new team member Zubi added: the card walks the owner through its setup (Claude sign-in) in the chat. */
      type: 'card';
      card: 'teammate';
      teammateId: string;
      name: string;
      role: string;
      status: 'pending' | 'ready' | 'skipped';
    }
  | {
      /** A file a team member saved in its Library: Open (when it can be shown) and Download. */
      type: 'card';
      card: 'file';
      /** Whose Library, and the path in it. */
      ownerId: string;
      name: string;
      path: string;
      size: number;
      canOpen: boolean;
      status: 'saved';
    }
  | {
      type: 'card';
      card: 'draft';
      channel: 'email' | 'slack' | 'message';
      to: string;
      subject?: string;
      text: string;
      approvalId: string;
      status: 'pending' | 'sent' | 'discarded';
    };

export interface EventBody {
  type: 'event';
  event: 'routine-created' | 'routine-updated' | 'routine-run' | 'task-changed' | 'bot-message' | 'conversation-cleared' | 'computer' | 'voice-call';
  text: string;
  ref?: string;
  /** voice-call only: the call record (set on the end-of-call row). */
  call?: VoiceCallRecord;
}

export interface VoiceCallRecord {
  id: string;
  phase: 'started' | 'ended';
  durationMs?: number;
  summary?: string;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  tasks?: string[];
}

export interface VoiceOption { id: string; name: string; gender?: string }

/** Live-call engines: xAI grok-voice (billed per open minute) or Google Gemini Live (billed per token). */
export type VoiceEngine = 'xai' | 'gemini';

export interface NoticeBody { type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error' }

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering';

export interface LiveState {
  botId: string;
  isRunning: boolean;
  activity: { kind: ActivityKind; detail?: string; since: number } | null;
  awaiting: { reason: string; since: number } | null;
  startedAt: number | null;
  /** Short line from the model's live reasoning, shown next to "Thinking". */
  caption?: string | null;
  /** Tool calls made so far in the current turn. */
  steps?: number;
  /** The owner asked it to pause when the step it is on finishes. */
  pausing?: boolean;
  /** The owner blocked its actions (it can talk and look things up, not send, post or delete). */
  blocked?: boolean;
  /** A guard on in this run: the circuit breaker blocked actions, stopped it, or it read outside content. */
  guard?: 'breaker' | 'stopped' | 'outside' | null;
}

export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string;
  /** When it was made (ms). */
  createdAt?: number | null;
}

export interface Task { id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number }

export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }

export interface LibraryFile { name: string; size: number; modifiedAt: number; isDir: boolean }

export interface ComputerState {
  status: 'absent' | 'creating' | 'starting' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error' | 'stopped';
  orgoId: string | null;
  error: string | null;
  /** One screen per bot on the shared computer. width/height are the screen's pixel size. */
  screens: { botId: string; screenId: string; width?: number; height?: number }[];
  /** How many bots can have their own screen at once. */
  maxScreens?: number;
}

/** A model provider Hermes can use (subscription sign-in or API key). */
export interface EngineProvider {
  id: string;
  name: string;
  kind: 'subscription' | 'api_key';
  connected: boolean;
  /** Suggested model ids for this provider. */
  models: string[];
}

/** The Hermes agent that runs one bot. */
export interface EngineInfo {
  botId: string;
  /** Hermes profile name ('default' for the primary bot). */
  profile: string;
  status: 'ready' | 'starting' | 'stopped' | 'error';
  error: string | null;
  model: string | null;
  provider: string | null;
  version: string | null;
  providers: EngineProvider[];
  /** Hermes is running a private screen of its own for this agent, so its computer work is not on the screen the app shows. */
  ownScreen: boolean;
}

export interface Toolkit {
  slug: string; name: string; logo?: string; description?: string; categories: string[];
  managedAuth: boolean; noAuth: boolean; connected: boolean;
}

/** A WhatsApp message a team member drafted; the owner checks it in the WhatsApp window and confirms there. */
/** The floating windows the app can open for the owner (besides WhatsApp). */
export type PanelName = 'gmail' | 'calendar' | 'youtube' | 'instagram' | 'facebook' | 'linkedin' | 'sheets' | 'notion';

export interface WaDraft {
  id: string;
  botId: string;
  botName: string;
  to: { kind: 'group' | 'person' | ''; name: string; number: string };
  text: string;
  /** A picture from Generations to send with the text as its caption (path inside the gallery). */
  image?: string;
  at: number;
}

/** A prompt saved for a team member: a chip above its message box (the most used) or in its list. */
export interface SavedPrompt { id: string; botId: string; title: string; text: string; byBot: boolean; uses: number; lastUsedAt: number | null }

/** Server-sent events on GET /api/events */
export type ServerEvent =
  | { type: 'whatsapp'; draft: WaDraft }
  | { type: 'whatsapp-close' }
  | { type: 'panel'; panel: PanelName; open: boolean }
  | { type: 'hello'; serverTime: number }
  | { type: 'rows'; botId: string; generation: number; rows: Row[] }
  | { type: 'cleared'; botId: string; generation: number }
  | { type: 'live'; state: LiveState }
  | { type: 'roster' }
  | { type: 'bot'; bot: Bot }
  | { type: 'computer'; state: ComputerState }
  | { type: 'routines'; botId: string }
  | { type: 'tasks'; botId: string }
  | { type: 'memories'; botId: string }
  | { type: 'prompts'; botId: string }
  | { type: 'social'; episodeId: string }
  | { type: 'connections' }
  | { type: 'ping' };
