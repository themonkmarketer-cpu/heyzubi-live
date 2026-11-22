import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from '@shared/avatar-shapes';
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
}

/** The part of the 100×100 drawing box that maps onto the slot. */
const VIEW = { x: 8, w: 84 };
const PUPIL_MIN_SIZE = 26;
/** HeyZubi eye colour (brand.json color.props.eye). */
const INK = '#0B0A0F';

function Eyes({ def, size }: { def: ShapeDef; size: number }) {
  const { y, dx, s } = def.eyes;
  const pupils = size >= PUPIL_MIN_SIZE;
  return (
    <g>
      {[-1, 1].map((side) => {
        const cx = 50 + side * dx;
        return (
          <g key={side}>
            <ellipse cx={cx} cy={y} rx={7 * s} ry={9 * s} fill="#FFFFFF" />
            {pupils && <circle cx={cx + 1.1 * s} cy={y + 2 * s} r={4 * s} fill={INK} />}
            {pupils && <circle cx={cx + 2.5 * s} cy={y + 0.5 * s} r={1.4 * s} fill="#FFFFFF" />}
          </g>
        );
      })}
    </g>
  );
}

export function BotAvatar({ shape, color, size, star, ring, className, title, mascot }: Props) {
  const def = shapeDef(shape);
  const fill = palette(color).fill;
  const unit = VIEW.w / size; // viewBox units per CSS px
  return (
    <span className={`bot-avatar ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      {mascot ? (
        // The mark's own viewBox has 10 units of padding; scale it up a little so Zubi fills the slot like a shape does.
        <img src={zubiMark} alt="" width={size} height={size} draggable={false}
          style={{ position: 'absolute', inset: 0, width: size, height: size, transform: 'scale(1.18)', pointerEvents: 'none' }} />
      ) : (
      <svg width={size} height={size} viewBox={`${VIEW.x} ${VIEW.x} ${VIEW.w} ${VIEW.w}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden>
        {ring && <path d={def.d} fill="#1C1C1C3D" stroke="#1C1C1C3D" strokeWidth={unit * 2 * 3.4} strokeLinejoin="round" />}
        {ring && <path d={def.d} fill="#FFFFFF" stroke="#FFFFFF" strokeWidth={unit * 2 * 2.4} strokeLinejoin="round" />}
        <path d={def.d} fill={fill} />
        <Eyes def={def} size={size} />
      </svg>
      )}
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

export function BotAvatarFor({ bot, size, star, className }: { bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> & { isPrimary?: boolean }; size: number; star?: boolean; className?: string }) {
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={star} className={className} title={bot.name} mascot={!!bot.isPrimary} />;
}
