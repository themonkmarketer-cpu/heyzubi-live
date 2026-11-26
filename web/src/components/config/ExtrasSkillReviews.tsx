import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { Glyph } from './glyphs';
import { jget, jpost } from './ExtrasApi';
import { shortDate } from './ui';

interface Review { botId: string; botName: string; name: string; path: string; status: 'pending' | 'rejected'; secretLike: boolean; seenAt: number }

/** Skills the bot wrote for itself that wait for the owner's OK (approve) or were kept off. */
export function SkillReviews({ bot, onDecided }: { bot: Bot; onDecided?: () => void }) {
  const [list, setList] = useState<Review[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    jget<{ reviews: Review[] }>(`/api/skill-reviews?bot=${encodeURIComponent(bot.id)}`).then((r) => setList(r.reviews.filter((x) => x.botId === bot.id))).catch(() => setList([]));
  }, [bot.id]);
  useEffect(load, [load]);
  const decide = async (r: Review, decision: 'approve' | 'reject') => {
    setBusy(r.path); setError(null);
    try { await jpost(`/api/skill-reviews/${encodeURIComponent(bot.id)}/decide`, { name: r.name, decision }); load(); onDecided?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  if (!list || !list.length) return null;
  const pending = list.filter((r) => r.status === 'pending');
  const rejected = list.filter((r) => r.status === 'rejected');
  return (
    <div className="cfg-agent-skills">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Waiting for your OK{pending.length ? ` (${pending.length})` : ''}</div>
          <div className="cfg-page__sub">Skills this bot writes for itself stay off until you approve them.</div>
        </div>
      </div>
      {pending.length === 0 ? <div className="cfg-empty">Nothing waiting.</div> : (
        <div className="cfg-list">
          {pending.map((r) => (
            <div key={r.path} className="cfg-item">
              <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
              <div className="cfg-item__text">
                <div className="cfg-item__title">{r.name}</div>
                <div className="cfg-item__meta">
                  {r.secretLike && <span className="cfg-chip xs-warn">May hold a key or password</span>}
                  {r.seenAt ? <span>Written {shortDate(r.seenAt)}</span> : null}
                </div>
              </div>
              <div className="cfg-item__actions xs-actions">
                <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy === r.path} onClick={() => void decide(r, 'reject')}>Keep off</button>
                <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy === r.path} onClick={() => void decide(r, 'approve')}>Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {rejected.length > 0 && (
        <div className="xs-kept">
          <div className="cfg-section__label">Kept off</div>
          {rejected.map((r) => (
            <div key={r.path} className="xs-kept__row">
              <span className="xs-kept__name">{r.secretLike ? '⚠ ' : ''}{r.name}</span>
              <button type="button" className="link-btn link-btn--small" disabled={busy === r.path} onClick={() => void decide(r, 'approve')}>Approve</button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="cfg-error cfg-error--small">{error}</div>}
    </div>
  );
}
