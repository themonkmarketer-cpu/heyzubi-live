import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type RFBType from '@novnc/novnc';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText, screenSize, screensFull } from '../lib/computer';
import { configApi } from '../lib/configApi';
import { useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { ClickyOverlay, useClicky } from './ClickyLayer';

export type ScreenMode = 'watch' | 'control';
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
type Phase = 'live' | 'switching' | 'waking' | 'asleep' | 'idle' | 'paused' | 'error';

interface ScreenProps {
  bot: Bot;
  /** 'panel' is the small live view in the details panel; 'stage' is the large view. */
  variant: 'panel' | 'stage';
  initialMode?: ScreenMode;
  /** Replaces "You're driving" under the frame, e.g. a sign-in the person has to finish. */
  hint?: string | null;
  /** Stop streaming and show a placeholder (the large view has this screen). */
  paused?: boolean;
  /** Panel only: the person asked for the large view, in this mode. */
  onExpand?: (mode: ScreenMode) => void;
  onModeChange?: (mode: ScreenMode) => void;
}

/**
 * A bot's screen on the shared computer: noVNC over our relay inside a rounded frame that keeps the
 * screen's aspect ratio. Watching is view-only. Taking control reconnects with mode=control and shows
 * a chin under the frame with the way back.
 */
export function ComputerScreen({ bot, variant, initialMode = 'watch', hint, paused = false, onExpand, onModeChange }: ScreenProps) {
  const computer = useStore((s) => s.computer);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const hadFrame = useRef(false);
  const autoWoke = useRef(false);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [conn, setConn] = useState<Conn>('idle');
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [opened, setOpened] = useState(variant === 'stage');
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [resetAsk, setResetAsk] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Paste box: shown when the browser won't let the page read the clipboard; normal Ctrl+V works in it.
  const [pasteBox, setPasteBox] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const status = computer?.status;
  const running = status === 'running';
  const busy = status === 'creating' || status === 'starting' || status === 'resuming';
  const hasScreen = !!computer?.screens.some((s) => s.botId === bot.id);
  const { width, height } = screenSize(computer, bot.id, bot.isPrimary);
  const driving = mode === 'control';
  const large = variant === 'stage' || fullscreen;
  // The small panel view only streams a screen that already exists, so browsing bots never uses up screens.
  const wantLive = running && !paused && (variant === 'stage' || visible) && (opened || hasScreen);

  const wake = useCallback(() => {
    setWaking(true); setWakeError(null);
    api.ensureComputer()
      .then(() => useStore.getState().loadComputer())
      .catch((e: Error) => setWakeError(e.message || 'The computer did not start.'))
      .finally(() => setWaking(false));
  }, []);

  // Opening the large view is a request to see the computer, so wake it without another click.
  useEffect(() => {
    if (variant !== 'stage' || autoWoke.current || !computer) return;
    if (status === 'suspended' || status === 'stopped' || status === 'absent') { autoWoke.current = true; wake(); }
  }, [variant, computer, status, wake]);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useEffect(() => {
    if (!wantLive || !canvasRef.current) { setConn('idle'); return; }
    let disposed = false;
    let rfb: RFBType | null = null;
    setConn('connecting');
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !canvasRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${mode}`;
      rfb = new RFB(canvasRef.current, url, { shared: true });
      rfb.viewOnly = mode === 'watch';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = mode === 'control';
      rfb.addEventListener('connect', () => { if (!disposed) { hadFrame.current = true; setConn('connected'); if (mode === 'control') rfb?.focus(); } });
      rfb.addEventListener('disconnect', (e) => { if (!disposed) setConn((e as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error'); });
      rfb.addEventListener('securityfailure', () => { if (!disposed) setConn('error'); });
      rfbRef.current = rfb;
    })().catch(() => { if (!disposed) setConn('error'); });
    const el = canvasRef.current;
    return () => {
      disposed = true;
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfbRef.current = null;
      el.innerHTML = '';
    };
  }, [bot.id, wantLive, mode, attempt]);

  useEffect(() => { onModeChange?.(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Paste into the bot's screen: put the text on its clipboard, then press Ctrl+V there. Without this,
   * Ctrl+V only reaches the screen as a key press and pastes whatever its own clipboard holds.
   * The text goes straight to the screen over the viewer's connection; it is not stored or logged.
   */
  const pasteToScreen = useCallback((text: string) => {
    const rfb = rfbRef.current;
    if (!rfb || !text) return;
    rfb.clipboardPasteFrom(text);
    setTimeout(() => {
      const r = rfbRef.current;
      if (!r) return;
      r.sendKey(0xffe3, 'ControlLeft', true);
      r.sendKey(0x0076, 'KeyV', true);
      r.sendKey(0x0076, 'KeyV', false);
      r.sendKey(0xffe3, 'ControlLeft', false);
      r.focus();
    }, 150);
  }, []);

  const paste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { pasteToScreen(text); return; }
    } catch { /* not allowed: use the paste box */ }
    setPasteText(''); setPasteBox(true);
  }, [pasteToScreen]);

  // While driving, Ctrl+V (Cmd+V on a Mac) on the screen pastes from this computer's clipboard.
  useEffect(() => {
    if (!driving) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v') return;
      if (!canvasRef.current || !(e.target instanceof Node) || !canvasRef.current.contains(e.target)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      void paste();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [driving, paste]);
  useEffect(() => { if (!driving) setPasteBox(false); }, [driving]);

  const handBack = useCallback(() => {
    setMode('watch');
    // The bot carries on either way; this only tells it sooner.
    configApi.handback(bot.id).catch(() => {});
  }, [bot.id]);

  // The panel view is too small to drive: control there only exists in full screen, and ends with it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (variant === 'panel' && !fullscreen && modeRef.current === 'control') handBack();
  }, [variant, fullscreen, handBack]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  useEffect(() => {
    if (!resetAsk) return;
    const t = setTimeout(() => setResetAsk(false), 6000);
    return () => clearTimeout(t);
  }, [resetAsk]);

  let phase: Phase;
  if (paused) phase = 'paused';
  else if (status === 'error' || wakeError) phase = 'error';
  else if (!running) phase = busy || waking ? 'waking' : 'asleep';
  else if (!opened && !hasScreen) phase = 'idle';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = hadFrame.current ? 'switching' : 'waking';

  const takeControl = () => {
    if (variant === 'panel' && !fullscreen) onExpand?.('control');
    else setMode('control');
  };
  const retry = () => {
    setWakeError(null);
    if (running) setAttempt((n) => n + 1);
    else wake();
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frameRef.current?.requestFullscreen().catch(() => setNote('Full screen isn’t available here.'));
  };
  const reset = async () => {
    setResetting(true);
    try { await configApi.resetScreen(bot.id); setAttempt((n) => n + 1); }
    catch { setNote('Couldn’t reset the screen.'); }
    finally { setResetting(false); setResetAsk(false); }
  };

  // Clicky: only in the large view, so the small panel never listens for the shortcut.
  const clicky = useClicky(bot, phase === 'live' && large);
  const asking = clicky.phase !== 'idle';
  const askBtn = (cls: string) => (
    <button
      type="button" className={`${cls} screen__ask${clicky.phase === 'listening' ? ' is-on' : ''}`}
      onPointerDown={clicky.button.onPointerDown} onPointerUp={clicky.button.onPointerUp} onKeyDown={clicky.button.onKeyDown}
      onMouseDown={(e) => e.preventDefault()}
      aria-label={`Ask ${bot.name} about this screen: hold to talk, or hold Ctrl+Alt`}
      title={`Ask ${bot.name}: hold to talk (or hold Ctrl+Alt). ${bot.name} answers out loud and points at what to click.`}
    >
      <Icon name="mic" size={14} />{clicky.phase === 'listening' ? 'Listening' : 'Ask'}
    </button>
  );
  // Typing instead of talking: a box in the controls; Enter asks, Escape closes.
  const [typeAsk, setTypeAsk] = useState(false);
  const [typeText, setTypeText] = useState('');
  const closeType = () => { setTypeAsk(false); setTypeText(''); };
  const typeBtn = (cls: string) => (
    <button type="button" className={cls} onClick={() => setTypeAsk(true)} aria-label={`Type a question for ${bot.name}`} title={`Type a question for ${bot.name} instead of talking`}>
      <Icon name="edit" size={15} />
    </button>
  );
  const typeBox = (
    <input
      className="screen__paste-input clicky__type" autoFocus autoComplete="off" maxLength={500}
      aria-label={`Ask ${bot.name} about this screen, then press Enter`}
      placeholder={`Ask ${bot.name} about this screen, then Enter`}
      value={typeText}
      onChange={(e) => setTypeText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation(); // keys here are for the box, not the screen or the viewer
        if (e.key === 'Enter') { e.preventDefault(); clicky.ask(typeText); closeType(); }
        if (e.key === 'Escape') { e.preventDefault(); closeType(); }
      }}
      onBlur={closeType}
    />
  );

  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const expandable = variant === 'panel' && !fullscreen && phase === 'live';
  const mascot = large ? 64 : 40;
  const style = { ...botVars(bot.avatarColor), ['--screen-ratio' as string]: String(width / height) } as CSSProperties;

  return (
    <div
      ref={frameRef}
      className={`screen screen--${variant} is-${phase}${driving ? ' is-driving' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      style={style}
    >
      <div className="screen__body">
        <div className="screen__view" style={{ aspectRatio: `${width} / ${height}` }}>
          <div ref={canvasRef} className="screen__canvas" />
          {/* noVNC swallows clicks on its canvas, so the way into the large view is a button laid over it. */}
          {expandable && <button type="button" className="screen__expand" onClick={() => onExpand?.('watch')} aria-label={`Open ${bot.name}’s computer in the large view`} title="Open the large view" />}

          {phase === 'live' && !driving && (
            <span className="screen__badge" aria-hidden>
              <BotAvatarFor bot={bot} size={16} />
              <span>Live</span>
              <i className="screen__live-dot" />
            </span>
          )}

          {phase === 'waking' && (
            <div className="screen__state is-waking" role="status">
              <span className="screen__sweep" aria-hidden />
              <span className="screen__mascot is-bobbing"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__label">Waking {bot.name}’s computer…</span>
            </div>
          )}
          {phase === 'switching' && (
            <div className="screen__state" role="status">
              <span className="screen__text">One moment…</span>
            </div>
          )}
          {phase === 'asleep' && (
            <div className="screen__state">
              <span className="screen__mascot is-asleep"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{status === 'suspending' ? 'Going to sleep…' : `${bot.name}’s computer is asleep`}</span>
              {status !== 'suspending' && <button type="button" className="screen__action" onClick={wake}>Wake it up</button>}
            </div>
          )}
          {phase === 'idle' && (
            <div className="screen__state">
              <span className="screen__mascot"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{bot.name} hasn’t opened a screen yet</span>
              {screensFull(computer, bot.id)
                ? <span className="screen__sub">All {computer?.maxScreens} screens are in use. Reset one in Settings to free it.</span>
                : <button type="button" className="screen__action" onClick={() => setOpened(true)}>Open its screen</button>}
            </div>
          )}
          {phase === 'paused' && (
            <div className="screen__state">
              <span className="screen__text">Open in the large view</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="screen__state" role="alert">
              <span className="screen__text">
                {!running ? `Couldn’t wake ${bot.name}’s computer` : conn === 'disconnected' ? 'The screen disconnected' : `Couldn’t reach ${bot.name}’s screen`}
              </span>
              {(wakeError || (status === 'error' && computer?.error)) && <span className="screen__sub">{wakeError ?? computer?.error}</span>}
              {running && screensFull(computer, bot.id) && <span className="screen__sub">All {computer?.maxScreens} screens are in use. Reset one in Settings to free it.</span>}
              <button type="button" className="screen__action" onClick={retry}>Retry</button>
            </div>
          )}

          {phase === 'live' && large && <ClickyOverlay bot={bot} clicky={clicky} />}

          {phase === 'live' && !driving && (
            <div className={`screen__pill${resetAsk || note || asking || typeAsk ? ' is-pinned' : ''}`} role="toolbar" aria-label="Screen controls">
              {note ? <span className="screen__pill-text" role="status">{note}</span> : typeAsk ? typeBox : resetAsk ? (
                <>
                  <span className="screen__pill-text">Close all windows?</span>
                  <button type="button" className="screen__pill-btn is-danger" onClick={reset} disabled={resetting}>{resetting ? 'Resetting…' : 'Reset'}</button>
                  <button type="button" className="screen__pill-btn" onClick={() => setResetAsk(false)} disabled={resetting}>Cancel</button>
                </>
              ) : (
                <>
                  <div className="screen__seg" role="group" aria-label="Who is using the screen">
                    <button type="button" className="screen__seg-btn is-active" aria-pressed="true">{large && <Icon name="eye" size={14} />}Watch</button>
                    <button type="button" className="screen__seg-btn" aria-pressed="false" onClick={takeControl}>{large && <Icon name="pointer" size={14} />}Take control</button>
                  </div>
                  <span className="screen__pill-rule" aria-hidden />
                  {large && askBtn('screen__pill-btn')}
                  {large && typeBtn('screen__pill-icon')}
                  {canFullscreen && (
                    <button type="button" className="screen__pill-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                      <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                    </button>
                  )}
                  <button type="button" className="screen__pill-icon" onClick={() => setResetAsk(true)} aria-label="Reset screen" title="Reset: close everything on this screen">
                    <Icon name="refresh" size={15} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {driving && (
          <div className="screen__chin">
            <span className="screen__chin-text" role="status">
              <i className="screen__ping" aria-hidden />
              <span>{hint || 'You’re driving'}</span>
            </span>
            <span className="screen__chin-actions">
              {large && (typeAsk ? typeBox : <>{askBtn('screen__chin-btn')}{typeBtn('screen__chin-icon')}</>)}
              {pasteBox ? (
                <input
                  className="screen__paste-input" type="password" autoFocus autoComplete="off" spellCheck={false}
                  aria-label={`Paste here, then press Enter to send it to ${bot.name}'s screen`}
                  placeholder="Paste here (Ctrl+V), then Enter"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); pasteToScreen(pasteText); setPasteText(''); setPasteBox(false); }
                    if (e.key === 'Escape') { setPasteText(''); setPasteBox(false); rfbRef.current?.focus(); }
                  }}
                  onBlur={() => { setPasteText(''); setPasteBox(false); }}
                />
              ) : (
                <button type="button" className="screen__chin-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => void paste()}
                  title={`Paste from this computer into ${bot.name}'s screen (or press Ctrl+V on the screen)`}>
                  Paste
                </button>
              )}
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              <button type="button" className="screen__handback" onClick={handBack}>
                <BotAvatarFor bot={bot} size={18} />
                <span>Hand back to {bot.name}</span>
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The large computer view: the bot's screen on a dimmed stage, opened from the chat menu or the details panel. */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const computer = useStore((s) => s.computer);
  const initialMode = useStore((s) => s.viewerMode);
  const hint = useStore((s) => s.viewerHint);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const botId = bot?.id;

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (mode === 'control' && botId) configApi.handback(botId).catch(() => {});
    set({ viewerOpen: false, viewerMode: 'watch', viewerHint: null });
  }, [mode, botId, set]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // While driving, Escape belongs to the remote desktop. In full screen the browser uses it to leave.
      if (e.key === 'Escape' && mode === 'watch' && !document.fullscreenElement) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mode, close]);

  const onModeChange = useCallback((m: ScreenMode) => {
    setMode(m);
    // A hint belongs to one stretch of driving; it goes once the person hands back.
    set(m === 'watch' ? { viewerMode: m, viewerHint: null } : { viewerMode: m });
  }, [set]);

  if (!bot) return null;

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`${bot.name}’s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" onClick={mode === 'watch' ? close : undefined} />
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{bot.name}’s computer</span>
          <span className="viewer__status">{computerStatusText(computer)}</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label="Close computer"><Icon name="close" color="#FFFFFF" /></button>
      </div>
      <div className="viewer__stage">
        <ComputerScreen key={bot.id} bot={bot} variant="stage" initialMode={initialMode} hint={hint} onModeChange={onModeChange} />
      </div>
    </div>
  );
}
