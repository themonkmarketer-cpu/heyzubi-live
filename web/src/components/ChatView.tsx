import { useMemo, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { keys } from '../lib/keys';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';
import { backgroundOf, useShownWallpaper, useWallpaper } from '../lib/wallpapers';
import '../styles/wallpaper.css';

export function ChatView() {
  const wallpaper = useShownWallpaper();
  const wallBg = backgroundOf(wallpaper.wallpaper, wallpaper.custom);
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat"><div className="empty-chat__sub">No one on your team is selected.</div></div>
      </main>
    );
  }

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2000); };

  return (
    <main className={`chat${wallBg ? ' has-wallpaper' : ''}`} style={botVars(bot.avatarColor)}>
      {wallBg && (
        <div className="chat__wallpaper" style={{ background: wallBg }} aria-hidden>
          <div className="chat__wallpaper-dim" style={{ opacity: wallpaper.dim }} />
        </div>
      )}
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer bot={bot} running={!!live?.isRunning} />
      <header className="chat__header">
        <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            <BotAvatarFor bot={bot} size={24} />
            <span className="chat__pill-name">{displayName(bot)}</span>
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                { label: detailsOpen ? 'Hide details' : 'Show details', hint: keys(',', true), onSelect: () => set({ detailsOpen: !detailsOpen }) },
                { label: 'Open computer', onSelect: () => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null }) },
                { label: 'New conversation', onSelect: () => api.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e) => flash(e.message)) },
                { label: 'Chat wallpaper…', onSelect: () => useWallpaper.getState().openPicker() },
                { label: 'Settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
              ]}
            />
          )}
        </span>
        <div className="chat__header-right">
          {!detailsOpen && (
            <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: true })} aria-label="Show details" title="Show details">
              <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
        </div>
      </header>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
