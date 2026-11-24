import type { AvatarColor } from '@shared/types';

/**
 * Bot colors. `fill` is the avatar/swatch color, `bubble` the user message bubble, `action` the
 * accent for toggles and the send button, and `hover` its hover state.
 */
export interface BotPalette { fill: string; bubble: string; action: string; hover: string }

/**
 * HeyZubi character colours (brand.json color.character) as the fills. `bubble`, `action` and
 * `hover` are darker shades of the same hue so white text on them keeps at least 4.6:1.
 * red = Waty, orange = Cleo, yellow = Zubi's gold, green = Costo, lime = Sally, cyan = Addy, blue = Grant,
 * violet = Zubi, magenta = Iris, gray = Marko.
 */
export const BOT_COLORS: Record<AvatarColor, BotPalette> = {
  // Black follows the theme (ink bubble, violet accent), so it uses tokens instead of hex.
  black: { fill: '#1B1622', bubble: 'var(--color-bubble-user)', action: 'var(--color-primary)', hover: 'var(--color-bg-primary-hover)' },
  brown: { fill: '#A0703F', bubble: '#885F36', action: '#996B3C', hover: '#7A5530' },
  red: { fill: '#E66556', bubble: '#C32E1D', action: '#DC3421', hover: '#AF291A' },
  orange: { fill: '#EA943E', bubble: '#9A5611', action: '#AF6113', hover: '#8A4D0F' },
  yellow: { fill: '#F0B429', bubble: '#866009', action: '#976C0B', hover: '#785608' },
  green: { fill: '#3EBC80', bubble: '#277550', action: '#2C845A', hover: '#226847' },
  lime: { fill: '#A6C83A', bubble: '#5A6E1B', action: '#62781D', hover: '#4E6018' },
  cyan: { fill: '#35BCD9', bubble: '#197083', action: '#1C7F94', hover: '#166576' },
  blue: { fill: '#4B94DD', bubble: '#2169B0', action: '#2677C8', hover: '#1E5E9F' },
  violet: { fill: '#8B5CF6', bubble: '#6B3FE0', action: '#6B3FE0', hover: '#5A32C7' },
  magenta: { fill: '#E067BB', bubble: '#B9268C', action: '#D02A9D', hover: '#A6227D' },
  gray: { fill: '#7E8EAF', bubble: '#56678B', action: '#62759D', hover: '#4D5D7C' },
};

/** Swatch order in the Create New Bot picker. */
export const COLOR_ORDER: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'lime', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

export const palette = (c: AvatarColor | string | undefined): BotPalette => BOT_COLORS[(c as AvatarColor) ?? 'black'] ?? BOT_COLORS.black;

/** CSS custom properties that theme a subtree with a bot's color. */
export function botVars(c: AvatarColor | string | undefined): React.CSSProperties {
  const p = palette(c);
  return {
    ['--bot-fill' as string]: p.fill, ['--bot-bubble' as string]: p.bubble, ['--bot-action' as string]: p.action, ['--bot-action-hover' as string]: p.hover,
    ['--bot-on-action' as string]: p === BOT_COLORS.black ? 'var(--color-on-primary)' : '#FFFFFF',
    ['--bot-action-soft' as string]: `color-mix(in srgb, ${p.action} 13%, transparent)`,
    ['--bot-action-text' as string]: p === BOT_COLORS.black ? 'var(--color-text-secondary)' : p.action,
  };
}
