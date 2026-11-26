import { useState } from 'react';
import type { SocialPost } from '../LivePanels';

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const n = (x: number) => Math.round(x).toLocaleString();

/** "Is my reach really down?": the latest 3 posts' median views against the median of the ones before. Worked out here, from the posts shown. */
export function reachVerdict(posts: SocialPost[]): { tone: 'down' | 'same' | 'up' | 'none'; text: string; tip: string } {
  const withViews = posts.filter((p) => typeof p.views === 'number'); // newest first, as the panel gives them
  if (withViews.length < 6) {
    return { tone: 'none', text: `There isn’t enough data yet: this needs at least 6 posts with a view count (there ${withViews.length === 1 ? 'is' : 'are'} ${withViews.length}).`, tip: 'Post a few more, then check again.' };
  }
  const recent = median(withViews.slice(0, 3).map((p) => p.views!));
  const before = median(withViews.slice(3).map((p) => p.views!));
  if (before <= 0) return { tone: 'none', text: 'The earlier posts have no views to compare with.', tip: 'Check again after a few more posts.' };
  const change = Math.round(((recent - before) / before) * 100);
  const vs = `your last 3 posts got a median of ${n(recent)} views against ${n(before)} before.`;
  if (change <= -15) return { tone: 'down', text: `Down ${Math.abs(change)}%: ${vs}`, tip: 'Compare posting times and formats of the last 3 with your best ones.' };
  if (change >= 15) return { tone: 'up', text: `Up ${change}%: ${vs}`, tip: 'Look at what the last 3 have in common and do more of it.' };
  return { tone: 'same', text: `About the same (${change > 0 ? '+' : ''}${change}%): ${vs}`, tip: 'Your reach is steady. Normal ups and downs are within 15%.' };
}

export function ReachCheck({ posts, followers }: { posts: SocialPost[]; followers?: number }) {
  const [shown, setShown] = useState(false);
  if (!shown) return <button type="button" className="lpanel__ask reach-check__btn" onClick={() => setShown(true)}>Is my reach really down?</button>;
  const v = reachVerdict(posts);
  return (
    <div className={`reach-check is-${v.tone}`} role="status">
      <b>{v.text}</b>
      {typeof followers === 'number' && <small>{followers.toLocaleString()} followers now.</small>}
      <small>{v.tip}</small>
      <button type="button" className="link-btn link-btn--small" onClick={() => setShown(false)}>Hide</button>
    </div>
  );
}
