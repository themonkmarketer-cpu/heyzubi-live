import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './modals/Modal';
import { Icon } from './Icon';
import { WALLPAPERS, backgroundOf, byId, customUrl, preparePicture, useWallpaper, wallpaperApi } from '../lib/wallpapers';
import '../styles/wallpaper.css';

type Choice = { kind: 'default' } | { kind: 'preset'; id: string } | { kind: 'custom'; url: string; blob?: Blob };

const idOf = (c: Choice) => (c.kind === 'default' ? null : c.kind === 'preset' ? c.id : 'custom');

/**
 * Chat wallpaper picker: the plain background, 10 built-in wallpapers or your own picture, with a live preview (in
 * here and on the chat behind) and a Dim slider so messages stay readable. Nothing is saved until Apply.
 */
export function WallpaperPicker() {
  const pref = useWallpaper((s) => s.pref);
  const closePicker = useWallpaper((s) => s.closePicker);
  const setPreview = useWallpaper((s) => s.setPreview);
  const saved = useWallpaper((s) => s.saved);

  const savedCustom = customUrl(pref.wallpaperFile);
  const [choice, setChoice] = useState<Choice>(() =>
    pref.wallpaper === 'custom' && savedCustom ? { kind: 'custom', url: savedCustom }
      : byId(pref.wallpaper) ? { kind: 'preset', id: pref.wallpaper! } : { kind: 'default' });
  const [dim, setDim] = useState(pref.wallpaperDim);
  const [busy, setBusy] = useState<'apply' | 'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const localUrl = useRef<string | null>(null);

  // The chat behind the picker shows the choice as you go; closing without Apply puts the saved one back.
  useEffect(() => {
    setPreview({ wallpaper: idOf(choice), dim, custom: choice.kind === 'custom' ? choice.url : null });
  }, [choice, dim, setPreview]);
  useEffect(() => () => { if (localUrl.current) URL.revokeObjectURL(localUrl.current); }, []);

  const close = useCallback(() => closePicker(), [closePicker]);

  const pickPreset = (id: string) => { setError(null); setChoice({ kind: 'preset', id }); setDim(byId(id)?.dim ?? 0); };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null); setBusy('upload');
    try {
      const blob = await preparePicture(f);
      if (localUrl.current) URL.revokeObjectURL(localUrl.current);
      localUrl.current = URL.createObjectURL(blob);
      setChoice({ kind: 'custom', url: localUrl.current, blob });
      setDim(0.25);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  };

  const apply = async () => {
    setError(null); setBusy('apply');
    try {
      if (choice.kind === 'custom' && choice.blob) await wallpaperApi.upload(choice.blob);
      saved(await wallpaperApi.save({ wallpaper: idOf(choice), wallpaperDim: dim }));
      closePicker();
    } catch (e) { setError((e as Error).message || 'Couldn’t save the wallpaper.'); }
    finally { setBusy(null); }
  };

  const removePicture = async () => {
    setError(null); setBusy('remove');
    try {
      saved(await wallpaperApi.remove());
      if (choice.kind === 'custom' && !choice.blob) setChoice({ kind: 'default' });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const shownBg = backgroundOf(idOf(choice), choice.kind === 'custom' ? choice.url : null);
  const customTileUrl = choice.kind === 'custom' ? choice.url : savedCustom;
  const selected = (c: Choice) => c.kind === choice.kind && (c.kind !== 'preset' || (choice.kind === 'preset' && c.id === choice.id));

  return (
    <Modal onClose={close} label="Chat wallpaper" className="wp-modal">
      <div className="modal__header">
        <div className="modal__title">Chat wallpaper</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} opacity={0.6} /></button>
      </div>

      <div className="wp-body">
        <div className="wp-preview" aria-label="Preview">
          <div className="wp-preview__bg" style={shownBg ? { background: shownBg } : undefined} />
          <div className="wp-preview__dim" style={{ opacity: shownBg ? dim : 0 }} />
          <div className={`wp-preview__chat${shownBg ? ' has-wallpaper' : ''}`}>
            <div className="wp-preview__pill">Today</div>
            <div className="bubble is-agent wp-preview__bubble">Morning! Three leads replied overnight. Want drafts?</div>
            <div className="bubble is-user wp-preview__bubble wp-preview__bubble--right">Yes, draft all three.</div>
            <div className="bubble is-agent wp-preview__bubble">On it. They’ll be in Tasks for your OK.</div>
          </div>
        </div>

        <div className="wp-side">
          <div className="wp-grid" role="radiogroup" aria-label="Wallpapers">
            <button type="button" role="radio" aria-checked={selected({ kind: 'default' })} className={`wp-tile wp-tile--default${selected({ kind: 'default' }) ? ' is-on' : ''}`} onClick={() => { setError(null); setChoice({ kind: 'default' }); }}>
              <span className="wp-tile__swatch" />
              <span className="wp-tile__name">Default</span>
            </button>
            {WALLPAPERS.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={selected({ kind: 'preset', id: w.id })} className={`wp-tile${selected({ kind: 'preset', id: w.id }) ? ' is-on' : ''}`} onClick={() => pickPreset(w.id)} title={`${w.name} · ${w.kind}`}>
                <span className="wp-tile__swatch" style={{ background: w.bg }} />
                <span className="wp-tile__name">{w.name}</span>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={choice.kind === 'custom'} className={`wp-tile wp-tile--upload${choice.kind === 'custom' ? ' is-on' : ''}`}
              onClick={() => (customTileUrl && choice.kind !== 'custom' ? setChoice({ kind: 'custom', url: customTileUrl }) : fileRef.current?.click())} disabled={busy === 'upload'}>
              <span className="wp-tile__swatch" style={customTileUrl ? { background: `url("${customTileUrl}") center / cover` } : undefined}>
                {!customTileUrl && <Icon name="plus" size={18} opacity={0.6} />}
              </span>
              <span className="wp-tile__name">{busy === 'upload' ? 'Preparing…' : customTileUrl ? 'Your picture' : 'Upload'}</span>
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />

          <div className="wp-row">
            <button type="button" className="link-btn link-btn--small" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              {customTileUrl ? 'Upload a different picture…' : 'Upload a picture…'}
            </button>
            {pref.wallpaperFile && <button type="button" className="link-btn link-btn--small" onClick={() => void removePicture()} disabled={busy !== null}>{busy === 'remove' ? 'Removing…' : 'Remove my picture'}</button>}
          </div>

          <label className={`wp-dim${choice.kind === 'default' ? ' is-off' : ''}`}>
            <span>Dim <em>{Math.round(dim * 100)}%</em></span>
            <input type="range" min={0} max={0.8} step={0.05} value={dim} disabled={choice.kind === 'default'} onChange={(e) => setDim(Number(e.target.value))} aria-label="Dim the wallpaper" />
          </label>
          <div className="wp-hint">Dimming lays your theme’s background over the wallpaper so messages stay easy to read. JPEG, PNG, WebP or HEIC; large pictures are shrunk before upload.</div>
          {error && <div className="wp-error" role="alert">{error}</div>}
        </div>
      </div>

      <div className="modal__footer">
        <button type="button" className="btn btn--sm wp-footer-left" onClick={() => { setError(null); setChoice({ kind: 'default' }); }} disabled={choice.kind === 'default'}>Use default</button>
        <button type="button" className="btn btn--sm" onClick={close}>Cancel</button>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void apply()} disabled={busy !== null}>{busy === 'apply' ? 'Saving…' : 'Apply'}</button>
      </div>
    </Modal>
  );
}
