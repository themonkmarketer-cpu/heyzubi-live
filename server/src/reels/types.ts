// Reels Factory: one cartoon reel (an episode) and the stages it goes through. The stages, their order, the gates
// and the rules are the ones the series was made with by hand; docs in the series' private folder (see store.ts).

export const STAGES = ['story', 'script', 'cast', 'screens', 'storyboard', 'render', 'review', 'edit', 'cover', 'package', 'schedule'] as const;
export type StageId = (typeof STAGES)[number];

/**
 * idle: something before it isn't finished · ready: can run · running · needs_you: waiting for the owner's decision ·
 * done: finished and approved · failed · stale: something before it changed since it ran.
 */
export type StageStatus = 'idle' | 'ready' | 'running' | 'needs_you' | 'done' | 'failed' | 'stale';

export interface StageState {
  status: StageStatus;
  progress?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** The owner's approval: when, and what was approved in their words or the button's. */
  approvedAt?: number;
  approval?: string;
}

export interface StoryOption { title: string; who: string; trade: string; aiEmployee: string; problem: string; hookSpeaker: string; hookLine: string; secondSpeaker: string; secondLine: string; unexpected: string; why: string }

export interface Shot {
  n: number; start: number; end: number;
  /** Camera: "Medium close-up, 50mm, eye-level, static". */
  camera: string;
  picture: string;
  speaker?: string; delivery?: string; line?: string; offscreen?: boolean;
  /** The caption wording when it differs from how the line is spoken ("no-shows"). */
  caption?: string;
  /** Screen shown in this shot (s1..s5). */
  screen?: string;
  clock?: string;
  sound?: string;
}
export interface PartScript { light: string; audio: string; props: string; time: string; shots: Shot[] }

export interface CastMember {
  key: string; name: string;
  /** series = already made (sheet and voice in the series), sheet = new character sheet, ref = one reference image, described = words only. */
  kind: 'series' | 'sheet' | 'ref' | 'described';
  castLine: string; lock: string; imagePrompt?: string;
  voice?: { voiceId: string; voiceName: string; stability: number; similarity: number; sample: string };
  parts: number[];
  /** Filled while making it. */
  image?: string; imageAsset?: string; voiceFile?: string; voiceAsset?: string; voiceSeconds?: number; imageUsd?: number; approved?: boolean; task?: string;
}

export interface Script {
  title: string; slug: string; trade: string; logline: string;
  aiEmployee: { name: string; icon: string; color: string; does: string[]; howItWorks: string };
  honesty: string; tip: string; forward: string; unexpected: string; runningGag: string; tradePhysics: string;
  keywords: { primary: string; ownerSide: string; secondary: string[]; evidence: string[]; facebookTags: string[]; youtubeTitle: string };
  location: string; cast: CastMember[]; parts: PartScript[];
  screens: Record<string, any>;
  caption: { line1: string; story: string };
  question: string; altText: string;
}

export interface Check { id: string; label: string; ok: boolean; level: 'must' | 'should'; detail?: string }

export interface RenderVersion { v: number; kind: 'part' | 'shot' | 'import' | 'voice'; provider: 'topview' | 'kie' | 'import' | 'elevenlabs'; task?: string; key?: string; state: 'quoted' | 'submitted' | 'completed' | 'failed' | 'payment_required'; file?: string; usd?: number; estimate?: number; note?: string; at: number; shot?: number; error?: string }
export interface LineCheck { speaker: string; text: string; heard: string; score: number; start: number; end: number; shot: number; pitch?: number; refPitch?: number; /** false: the line is heard but the speaker's mouth doesn't move. */ lips?: boolean }
export interface PartReview { cuts: number[]; frames: number; fps: number; lines: LineCheck[]; sheet: string; words: [number, number, string][]; notes: string[]; hookAt: number; secondVoiceAt: number; shotStarts: number[]; asl: number }

export interface Comment { id: string; at: number; text: string; part?: number; shot?: number; t?: number; x?: number; y?: number; done?: boolean }
export interface LedgerRow { at: number; what: string; provider: string; model?: string; task?: string; usd: number; estimate?: number; state: string; credits?: number }

export interface Episode {
  id: string; num: number; title: string; createdAt: number; updatedAt: number;
  capUsd: number; auto: boolean; archived?: boolean;
  stages: Record<StageId, StageState>;
  ledger: LedgerRow[];
  story: { brief: string; hookStyle: string; options: StoryOption[]; picked: StoryOption | null };
  script: Script | null; checks: Check[]; scriptNote?: string;
  /** Does one of the owner's AI Employees really do this? Asked with the script. */
  aiConfirmed?: 'yes' | 'later';
  /** Standing notes the owner gave in the session window. */
  notes?: string[];
  /** The owner's notes: on the whole video, on a shot, or pinned to a point of a still. */
  comments?: Comment[];
  cast: CastMember[];
  screens: { id: string; kind: string; title: string; png: string; html: string }[];
  storyboard: { prompts: string[]; chars: number[]; checks: Check[]; refs: { images: string[]; audio: string[]; video: string }[]; quoteUsd: number | null; usualUsd?: number; quotedAt?: number; refData?: { images: { name: string; asset: string }[]; audio: { name: string; asset: string; seconds: number }[] }[] } | null;
  render: { parts: { versions: RenderVersion[]; picked: number | null }[]; provider: 'topview' | 'kie'; /** The owner's clip cut from Part 2: the reference video of Part 1. */ lead?: { v: number; key: string; file: string; asset: string; doubt?: string } };
  review: (PartReview | null)[];
  edit: {
    options: { musicDb: number; trimStart: number; trimEnd: number; dropShots: { part: number; shot: number }[]; /** Dark shots lifted a little. */ brighten?: { part: number; shot: number }[]; /** Seconds taken off the start and end of a shot. */ trims?: { part: number; shot: number; in: number; out: number }[]; /** A screen on another shot's device ("part-shot": screen), or "" for none. */ screenOn?: Record<string, string>; screens: Record<string, { on: boolean; f0?: number; f1?: number; motion?: 'track' | 'static' }>; captionFixes: [string, string][] };
    /** What the project was when this cut was made (HyperFrames editor). */ studioSig?: string; /** Each part as it is in this cut. */ partFiles?: string[]; final: string | null; seconds?: number; lufs?: number; peak?: number; version: number; checks: Check[]; screenStats?: Record<string, any>; previews?: string[];
  };
  cover: { candidates: { t: number; file: string; note?: string }[]; picked: string | null };
  pack: { instagram: string; facebook: string; commentInstagram: string; commentFacebook: string; /** The line for WhatsApp Status, and YouTube's pinned comment. */ whatsapp?: string; youtubeComment?: string; altText: string; keywords: string[]; facebookTags: string[]; youtubeTitle: string; youtubeDescription: string; youtubeTags: string[]; keywordPlaces: string[]; slot: string | null; platforms: string[]; checks: Check[]; folder: string | null } | null;
  schedule: { method: 'zubi' | 'self' | null; results: Record<string, { status: 'asked' | 'scheduled' | 'live' | 'failed'; link?: string; note?: string; at: number }>; askedAt?: number };
}

export interface Slot { at: string; label: string; us: string; taken?: string }
