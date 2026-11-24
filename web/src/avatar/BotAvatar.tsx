import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from '@shared/avatar-shapes';
import { avatarMarkup, lookOf, propFor, type PropId } from '@shared/avatar-props';
import zubiMark from '../assets/zubi-live.svg';

export function shapeDef(shape: AvatarShape | string): ShapeDef {
  return SHAPES[shape as AvatarShape] ?? SHAPES.blob;
}

/** Shapes offered in the Create New Bot picker (rows of 5/5/3). */
export const PICKER_SHAPES: AvatarShape[] = ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'];

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. The body fills the slot; the ring draws just outside it. */
  size: number;
  star?: boolean;
  /** Selected-shape ring (white gap + gray outline following the silhouette). */
  ring?: boolean;
  className?: string;
  title?: string;
  /** Draw the HeyZubi mascot (Zubi) instead of the shape: used for the main bot. */
  mascot?: boolean;
  /** The character it is drawn as (a body and a prop for its job, as the HeyZubi cast); none = its plain shape. */
  prop?: PropId | null;
}

/** Avatars this big blink and sway their prop, as the cast does in the HeyZubi deck. Smaller ones stay still. */
const ALIVE_MIN_SIZE = 36;

export function BotAvatar({ shape, color, size, star, ring, className, title, mascot, prop }: Props) {
  const look = lookOf(shape, prop);
  const fill = palette(color).fill;
  const [, , w] = look.box;
  const alive = !mascot && size >= ALIVE_MIN_SIZE;
  return (
    <span className={`bot-avatar${alive ? ' is-alive' : ''} ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      {mascot ? (
        // The mark's own viewBox has 10 units of padding; scale it up a little so Zubi fills the slot like a shape does.
        <img src={zubiMark} alt="" width={size} height={size} draggable={false}
          style={{ position: 'absolute', inset: 0, width: size, height: size, transform: 'scale(1.18)', pointerEvents: 'none' }} />
      ) : (
        // The markup is our own constant drawing (avatar-props.ts) and a palette colour, never user text.
        <svg width={size} height={size} viewBox={look.box.join(' ')} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden
          dangerouslySetInnerHTML={{ __html: avatarMarkup(look, fill, ring ? { ring: w / size } : {}) }} />
      )}
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

type AvatarBot = Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> & { isPrimary?: boolean; label?: string; description?: string; avatarProp?: string | null };

export function BotAvatarFor({ bot, size, star, className }: { bot: AvatarBot; size: number; star?: boolean; className?: string }) {
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={star} className={className} title={bot.name} mascot={!!bot.isPrimary} prop={propFor(bot)} />;
}
