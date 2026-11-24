import { SHAPES, type ShapeDef } from './avatar-shapes.js';
import type { AvatarShape } from './types.js';

/**
 * The team's characters, built the HeyZubi way (heyzubi-app/brand/brand.json `avatar`, as in the Academy deck): every
 * character has a body of its own, the same small dark eyes with a white glint, and one bold prop for what it is good
 * at, drawn as part of the figure (Iris's paintbrush, Grant's gold glasses, Costo's lifebuoy). No mouths, no limbs.
 *
 * Nine come straight from the brand cast; six more (laptop, sales chart, fountain pen, envelope, calendar, gear) are
 * drawn the same way for roles the cast doesn't cover. A bot's character is picked from its role, or chosen in its
 * settings; the bot's own colour fills it. Without one, the bot keeps its plain shape with the same eyes.
 *
 * All markup is in a 100×100 box and is our own constant drawing (never user text), shared by the web avatar and the
 * sticker on a bot's own screen. `class="eye"` and `class="prop"` let the app blink the eyes and sway the prop.
 */

export const PROP_IDS = [
  'clapper', 'brush', 'magnifier', 'code', 'glasses', 'trend', 'megaphone', 'lifebuoy', 'headset', 'pen', 'envelope', 'calendar', 'flag', 'compass', 'gear',
] as const;
export type PropId = (typeof PROP_IDS)[number];

const DARK = '#16161B';
const GOLD = '#F0B429';
const C = { cream: '#F1E4CF', teal: '#22C3B0', gold: '#D4AF5A', white: '#FFFFFF', glass: '#E9F6FF', green: '#22B573', red: '#E5484D', blue: '#3B5BDB', steel: '#D9DCE4' };

/** Polygon with rounded corners (quadratic corners of radius r), for the new bodies. */
function roundPoly(pts: [number, number][], r: number): string {
  const f = (n: number) => +n.toFixed(2);
  let d = '';
  pts.forEach((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const p1 = [p[0] + ((a[0] - p[0]) * r) / da, p[1] + ((a[1] - p[1]) * r) / da];
    const p2 = [p[0] + ((b[0] - p[0]) * r) / db, p[1] + ((b[1] - p[1]) * r) / db];
    d += `${i ? 'L' : 'M'}${f(p1[0])} ${f(p1[1])}Q${p[0]} ${p[1]} ${f(p2[0])} ${f(p2[1])}`;
  });
  return `${d}Z`;
}

function gearPath(cx: number, cy: number, rOut: number, rIn: number, teeth: number): string {
  const pts: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    for (const off of [-1, 1]) {
      const a = (Math.PI * i) / teeth + (off * Math.PI) / teeth / 2.3;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
  }
  return `M${pts.join('L')}Z`;
}

interface Character {
  label: string;
  /** What it stands for (picker tooltip). */
  means: string;
  /** Words in a bot's role, name or description that pick it. Checked in PROP_IDS order. */
  words: RegExp;
  /** Body: element markup without fill (the bot's colour fills it). */
  body: string;
  eyeY: number;
  /** Under the body / over the body and eyes. */
  back?: string;
  front?: string;
}

export const PROPS: Record<PropId, Character> = {
  // ---- from the brand cast ----
  clapper: {
    label: 'Clapperboard', means: 'video', // Nova
    words: /\b(video|videos|film|reels?|youtube|tiktok|animation|motion)\b/i,
    body: '<path d="M23 88Q13 88 14 77C15 45 29 20 50 20C71 20 85 45 86 77Q87 88 77 88Z"/>', eyeY: 58,
    front: `<g class="prop"><rect x="31" y="9" width="38" height="12" rx="2" fill="${DARK}"/><path d="M36 9l5 12M46 9l5 12M56 9l5 12" stroke="#FFFFFF" stroke-width="3"/></g>`,
  },
  brush: {
    label: 'Paintbrush', means: 'images and design', // Iris
    words: /\b(image|images|design|designer|art|artist|graphic|illustrat\w*|logo|visual|photo\w*|thumbnail|creative)\b/i,
    body: '<path d="M27 86C13 86 8 73 14 64C6 54 13 39 28 42C29 27 46 19 58 29C70 20 88 30 85 46C95 52 94 76 79 86Z"/>', eyeY: 60,
    front: `<g class="prop" stroke-linecap="round"><path d="M68 26L84 8" stroke="${C.cream}" stroke-width="4.5"/><path d="M84 8L90 2" stroke="${C.teal}" stroke-width="6"/></g>`,
  },
  magnifier: {
    label: 'Magnifier', means: 'research and finding leads', // Sally
    words: /\b(research\w*|scout\w*|investigat\w*|find|finds|finder|search|seo|prospect\w*|discover\w*|enquir\w*|inquir\w*)\b/i,
    body: '<path d="M38 14.8Q46 6 55.8 15.2L85.2 42.8Q95 52 85.2 60.8L55.8 87.2Q46 96 38 86.8L14 59.2Q6 50 14 41.2Z"/>', eyeY: 51,
    front: `<g class="prop"><g stroke-linecap="round"><path d="M74 30L63 42" stroke="${DARK}" stroke-width="5"/><circle cx="82" cy="22" r="11" fill="${C.glass}" stroke="${DARK}" stroke-width="4"/></g><path d="M77 18A6 6 0 0 1 82 16" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></g>`,
  },
  glasses: {
    label: 'Gold glasses', means: 'numbers, finance and bookkeeping', // Grant
    words: /\b(financ\w*|bookkeep\w*|account\w*|cfo|invoic\w*|tax|taxes|budget\w*|payroll|money|expenses?)\b/i,
    body: '<rect x="15" y="22" width="70" height="66" rx="27"/>', eyeY: 52,
    front: `<g fill="none" stroke="${C.gold}" stroke-width="3"><circle cx="40" cy="52" r="9"/><circle cx="60" cy="52" r="9"/><path d="M49 51h2"/></g>`,
  },
  megaphone: {
    label: 'Megaphone', means: 'marketing, social and publishing', // Cleo
    words: /\b(market\w*|social|publish\w*|content|instagram|linkedin|twitter|posts?|posting|brand|community|pr|promot\w*|growth)\b/i,
    body: '<path d="M56 8C58 26 86 38 86 62C86 80 70 91 50 91C30 91 14 80 14 62C14 40 44 32 56 8Z"/>', eyeY: 62,
    front: `<g class="prop"><path d="M84 44L97 35V59L84 50Z" fill="#FFF3E3" stroke="#2A1C10" stroke-width="2.2" stroke-linejoin="round"/><rect x="80" y="43" width="5" height="8" rx="2" fill="#2A1C10"/></g>`,
  },
  lifebuoy: {
    label: 'Lifebuoy', means: 'customer support and help', // Costo
    words: /\b(support|helpdesk|help desk|tickets?|customer service|customer care|complaints?)\b/i,
    body: '<path d="M50 8C64 16 78 18 88 18C89 56 77 80 50 92C23 80 11 56 12 18C22 18 36 16 50 8Z"/>', eyeY: 50,
    front: `<g class="prop"><circle cx="77" cy="77" r="13" fill="none" stroke="#FFFFFF" stroke-width="9"/><circle cx="77" cy="77" r="13" fill="none" stroke="${DARK}" stroke-width="9" stroke-dasharray="10.2 10.2"/><circle cx="77" cy="77" r="17.5" fill="none" stroke="${DARK}" stroke-width="1.6"/><circle cx="77" cy="77" r="8.5" fill="none" stroke="${DARK}" stroke-width="1.6"/></g>`,
  },
  headset: {
    label: 'Headset', means: 'conversations, calls and WhatsApp', // Waty
    words: /\b(whatsapp|calls?|phone|reception\w*|chat|chats|conversations?|inbound|customers?)\b/i,
    body: '<path d="M50 14C74 14 90 29 90 48C90 67 74 80 52 80C46 80 40 79 35 77L16 88L23 71C15 65 10 57 10 48C10 29 26 14 50 14Z"/>', eyeY: 47,
    back: `<path d="M12 50C12 22 88 22 88 50" fill="none" stroke="${DARK}" stroke-width="5" stroke-linecap="round"/>`,
    front: `<rect x="5" y="42" width="11" height="16" rx="4" fill="${DARK}"/><rect x="84" y="42" width="11" height="16" rx="4" fill="${DARK}"/><path d="M89 57C89 68 80 72 70 72" fill="none" stroke="${DARK}" stroke-width="3"/><circle cx="68" cy="72" r="3.5" fill="${DARK}"/>`,
  },
  flag: {
    label: 'Flag', means: 'campaigns, ads and launches', // Addy
    words: /\b(ads?|advert\w*|campaigns?|launch\w*|paid|ppc)\b/i,
    body: '<path d="M43.9 18.7Q50 12 56.1 18.7Q62.2 25.4 71.3 25Q80.4 24.6 80 33.7Q79.6 42.8 86.3 48.9Q93 55 86.3 61.1Q79.6 67.2 80 76.3Q80.4 85.4 71.3 85Q62.2 84.6 56.1 91.3Q50 98 43.9 91.3Q37.8 84.6 28.7 85Q19.6 85.4 20 76.3Q20.4 67.2 13.7 61.1Q7 55 13.7 48.9Q20.4 42.8 20 33.7Q19.6 24.6 28.7 25Q37.8 25.4 43.9 18.7Z"/>', eyeY: 55,
    back: `<g class="prop"><path d="M70 32V4" stroke="${DARK}" stroke-width="3.5" stroke-linecap="round"/><path d="M70 6H95L88.5 13.5L95 21H70Z" fill="#FFFFFF" stroke="${DARK}" stroke-width="2.4" stroke-linejoin="round"/></g>`,
  },
  compass: {
    label: 'Compass', means: 'plans, strategy and projects', // Marko
    words: /\b(strateg\w*|plan|plans|planning|planner|projects?|operations manager|coordinat\w*|chief of staff)\b/i,
    body: '<path d="M22.2 22.4Q27 14 37.1 14L62.9 14Q73 14 77.8 22.4L90.2 43.6Q95 52 90.2 60.4L77.8 81.6Q73 90 62.9 90L37.1 90Q27 90 22.2 81.6L9.8 60.4Q5 52 9.8 43.6Z"/>', eyeY: 52,
    front: `<g class="prop"><circle cx="80" cy="24" r="13" fill="${C.cream}" stroke="${DARK}" stroke-width="4"/><path d="M80 14L84.5 24H75.5Z" fill="${C.teal}"/><path d="M80 34L84.5 24H75.5Z" fill="${DARK}"/></g>`,
  },

  // ---- new, drawn the same way ----
  code: {
    label: 'Terminal', means: 'code and building software',
    words: /\b(dev|devs|develop\w*|code|coder|coding|engineer\w*|programm\w*|software|website|webapp|frontend|backend|full.?stack)\b/i,
    // A tall capsule holding a little terminal window at its shoulder: three window dots and a >_ prompt.
    body: '<rect x="20" y="14" width="60" height="76" rx="30"/>', eyeY: 52,
    front: `<g class="prop" transform="rotate(-10 78 18)"><rect x="62" y="5" width="32" height="24" rx="4.5" fill="${DARK}"/>`
      + `<circle cx="67.5" cy="10" r="1.4" fill="#FF6B5E"/><circle cx="72" cy="10" r="1.4" fill="${GOLD}"/><circle cx="76.5" cy="10" r="1.4" fill="${C.teal}"/>`
      + `<path d="M67.5 16.5L72 20L67.5 23.5" fill="none" stroke="${C.teal}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M75.5 24H84" stroke="${C.teal}" stroke-width="2.8" stroke-linecap="round"/></g>`,
  },
  trend: {
    label: 'Rising arrow', means: 'sales, pipeline and results',
    words: /\b(sales|sell\w*|pipeline|revenue|deals?|crm|metrics?|kpis?|analytics|analyst|reports?|reporting)\b/i,
    // A pebble with a gold trend line climbing out of its shoulder, held up like Iris's brush.
    body: '<path d="M48 16C70 16 86 34 86 57C86 78 70 90 49 90C27 90 13 77 13 57C13 34 27 16 48 16Z"/>', eyeY: 57,
    front: `<g class="prop"><path d="M57 37L66 27.5L72.5 32L83 18.5" fill="none" stroke="${GOLD}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="M88.6 11.3L89 22.4L78.6 16.2Z" fill="${GOLD}" stroke="${GOLD}" stroke-width="2" stroke-linejoin="round"/></g>`,
  },
  pen: {
    label: 'Fountain pen', means: 'writing and copy',
    words: /\b(writ\w*|copy|copywrit\w*|blog\w*|newsletters?|scripts?|author|stor(y|ies)|journal\w*|editor)\b/i,
    // A page with a folded corner and a fountain pen across its top left.
    body: '<path d="M24 14H62L84 36V82Q84 90 76 90H24Q16 90 16 82V22Q16 14 24 14Z"/>', eyeY: 54,
    front: '<path d="M62 14V30Q62 36 68 36H84Z" fill="#FFFFFF" fill-opacity=".45"/>'
      + `<g class="prop"><path d="M37 33L19 12" stroke="${C.blue}" stroke-width="6.5" stroke-linecap="round"/><path d="M21.6 9.8L16.4 14.2" stroke="${C.gold}" stroke-width="2.8" stroke-linecap="round"/>`
      + `<path d="M21.6 9.8L13.2 3.6L16.4 14.2Z" fill="${C.gold}" stroke="${DARK}" stroke-width="1.4" stroke-linejoin="round"/></g>`,
  },
  envelope: {
    label: 'Envelope', means: 'email and outreach',
    words: /\b(e-?mails?|inbox|outreach|mail|mailing|cold)\b/i,
    // A mailbox arch with a letter tucked at its shoulder.
    body: '<path d="M16 84V50A34 34 0 0 1 84 50V84Q84 90 78 90H22Q16 90 16 84Z"/>', eyeY: 54,
    front: `<g class="prop" transform="rotate(-14 76 17)"><rect x="64" y="9" width="24" height="16" rx="2.5" fill="#FFFFFF" stroke="${DARK}" stroke-width="2.6"/>`
      + `<path d="M65.5 10.5L76 18L86.5 10.5" fill="none" stroke="${DARK}" stroke-width="2.6" stroke-linejoin="round"/></g>`,
  },
  calendar: {
    label: 'Calendar', means: 'scheduling and running the day',
    words: /\b(schedul\w*|calendar|bookings?|appointments?|assistant|admin\w*|secretary|meetings?|diary|reminders?)\b/i,
    // A low capsule with a small checked calendar page at its shoulder.
    body: '<rect x="11" y="32" width="78" height="56" rx="28"/>', eyeY: 59,
    front: `<g class="prop"><rect x="64" y="10" width="24" height="22" rx="4" fill="#FFFFFF" stroke="${DARK}" stroke-width="2.6"/>`
      + `<path d="M64 14Q64 10 68 10H84Q88 10 88 14V17H64Z" fill="${C.red}" stroke="${DARK}" stroke-width="2.6" stroke-linejoin="round"/>`
      + `<path d="M70 6.5V12.5M82 6.5V12.5" stroke="${DARK}" stroke-width="3" stroke-linecap="round"/>`
      + `<path d="M70 24.5L74 28L82.5 20.5" fill="none" stroke="${C.green}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>`,
  },
  gear: {
    label: 'Gear', means: 'automations, systems and operations',
    words: /\b(automat\w*|ops|devops|operations|workflows?|integrat\w*|systems?|infrastructure)\b/i,
    body: `<path d="${roundPoly([[50, 8], [87, 29], [87, 71], [50, 92], [13, 71], [13, 29]], 10)}"/>`, eyeY: 48,
    front: `<g class="prop"><path d="${gearPath(76, 76, 16, 11.8, 8)}" fill="${DARK}"/><circle cx="76" cy="76" r="5.6" fill="${C.cream}"/></g>`,
  },
};

/** The bot colours' fills, the same as the web app's palette (web/src/lib/colors.ts BOT_COLORS). */
export const AVATAR_FILL: Record<string, string> = {
  black: '#1B1622', brown: '#A0703F', red: '#E66556', orange: '#EA943E', yellow: '#F0B429', green: '#3EBC80', lime: '#A6C83A',
  cyan: '#35BCD9', blue: '#4B94DD', violet: '#8B5CF6', magenta: '#E067BB', gray: '#7E8EAF',
};

export const isPropId = (v: unknown): v is PropId => typeof v === 'string' && (PROP_IDS as readonly string[]).includes(v);

/**
 * The character a bot is drawn as. `avatarProp` is what the user picked: a character, 'none' (its plain shape), or
 * nothing (picked from the role, then the name, then the description, so it follows when the role changes).
 */
export function propFor(bot: { avatarProp?: string | null; name?: string; label?: string; description?: string }): PropId | null {
  if (bot.avatarProp === 'none') return null;
  if (isPropId(bot.avatarProp)) return bot.avatarProp;
  for (const text of [bot.label, bot.name, bot.description]) {
    if (!text) continue;
    for (const id of PROP_IDS) if (PROPS[id].words.test(text)) return id;
  }
  return null;
}

/** What to draw: a character, or the plain shape with the same eyes. `box` is the viewBox that frames it. */
export interface Look { body: string; eyeY: number; dx: number; s: number; back: string; front: string; box: [number, number, number, number] }

export function lookOf(shape: AvatarShape | string, prop: PropId | null | undefined): Look {
  if (prop && PROPS[prop]) {
    const c = PROPS[prop];
    return { body: c.body, eyeY: c.eyeY, dx: 10, s: 1, back: c.back ?? '', front: c.front ?? '', box: [0, 0, 100, 100] };
  }
  const def: ShapeDef = SHAPES[shape as AvatarShape] ?? SHAPES.blob;
  return { body: `<path d="${def.d}"/>`, eyeY: def.eyes.y, dx: def.eyes.dx, s: def.eyes.s, back: '', front: '', box: [8, 8, 84, 84] };
}

/** Dark fills (the black bot colour) get light eyes, or they would vanish. */
function isDark(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.22;
}

/**
 * The inside of the avatar's <svg> (use `look.box` as its viewBox). `ring` (viewBox units per CSS px) draws the
 * picker's selection ring round the body; `sticker` gives the body a white edge, as on the bot's screen.
 */
export function avatarMarkup(look: Look, fill: string, opts: { ring?: number; sticker?: boolean } = {}): string {
  const { body, eyeY: y, dx, s } = look;
  const dark = isDark(fill);
  const eyes = [50 - dx, 50 + dx].map((cx) =>
    `<ellipse class="eye" cx="${cx}" cy="${y}" rx="${4.6 * s}" ry="${6.2 * s}" fill="${dark ? '#FFFFFF' : '#0B0A0F'}"/>`
    + `<circle cx="${+(cx + 1.6 * s).toFixed(2)}" cy="${+(y - 2.4 * s).toFixed(2)}" r="${1.6 * s}" fill="${dark ? '#0B0A0F' : '#FFFFFF'}"/>`).join('');
  const edge = opts.ring
    ? `<g fill="#1C1C1C3D" stroke="#1C1C1C3D" stroke-width="${opts.ring * 6.8}" stroke-linejoin="round">${body}</g><g fill="#FFFFFF" stroke="#FFFFFF" stroke-width="${opts.ring * 4.8}" stroke-linejoin="round">${body}</g>`
    : opts.sticker ? `<g fill="#FFFFFF" stroke="#FFFFFF" stroke-width="6" stroke-linejoin="round">${body}</g>` : '';
  return `${look.back}${edge}<g fill="${fill}">${body}</g>${eyes}${look.front}`;
}
