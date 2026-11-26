import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { useStore } from '../../store';
import { kanbanApi, type KanbanBoardData, type KanbanBoardMeta, type KanbanCard, type KanbanWorkflow } from '../../lib/kanbanApi';
import { Icon } from '../Icon';
import { CreateDialog, MoveDialog, type NewCard } from './BoardDialogs';
import { TaskCard } from './TaskCard';
import { TaskDrawer } from './TaskDrawer';
import {
  ADDABLE, BOT_RULES, canMove, COLUMN_HINT, isFiltering, isOwner, landingIndex, matches, newKey, NO_FILTERS, orderCards, planMove, PRIORITISED, UNASSIGNED,
  type CardOrder, type Filters, type MovePlan,
} from './boardModel';
import { lsGet, lsSet } from '../../lib/storage';
import { NewWorkerDialog, WorkersPopover } from '../extras/Workers';
import { useBoardFocus } from '../extras/clientsWindow';
import '../../styles/board.css';
import '../../styles/routines.css'; // the Bot and Sort pickers, shared with Tasks and Routines

/**
 * The Board: Hermes's own Kanban as columns of cards. Hermes is the source of truth for everything shown here: its
 * workflow gives the columns and which moves are allowed, its dispatch order gives the order inside a column, and every
 * change goes through its own update. Nothing is stored in HeyZubi. Changes made elsewhere (Hermes's app, its agents)
 * come in through Hermes's event counter, checked every few seconds; the header says when it last checked.
 */

const POLL_MS = 4000;

function useWho() {
  const bots = useStore((s) => s.bots);
  const byProfile = useMemo(() => new Map(bots.filter((b) => b.hermesProfile).map((b) => [b.hermesProfile as string, b])), [bots]);
  const who = useCallback((p: string) => (isOwner(p) ? 'You' : byProfile.get(p)?.name ?? p), [byProfile]);
  return { bots: byProfile, who };
}

function QuickAdd({ column, onAdd }: { column: string; onAdd: (title: string, key: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(newKey());
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  if (!open) return <button type="button" className="kb-add" onClick={() => setOpen(true)}><Icon name="plus" size={12} /> Add task</button>;
  const close = () => { setOpen(false); setText(''); setErr(null); };
  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    const e = await onAdd(title, key.current);
    setBusy(false);
    setErr(e);
    if (!e) { setText(''); key.current = newKey(); ref.current?.focus(); } // stays open for the next one
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  return (
    <div className="kb-compose">
      <textarea ref={ref} className="kb-compose__input" rows={2} maxLength={300} value={text} placeholder="What needs doing?" aria-label={`New task in ${column}`}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={busy} />
      {err && <div className="kb-compose__err" role="alert">{err}</div>}
      <div className="kb-compose__row">
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!text.trim() || busy} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add task'}</button>
        <button type="button" className="icon-btn icon-btn--plain" aria-label="Cancel" onClick={close}><Icon name="close" size={12} /></button>
      </div>
    </div>
  );
}

function syncedText(at: number | null) {
  if (!at) return '';
  const s = Math.round((Date.now() - at) / 1000);
  return s < 10 ? 'Synced just now' : s < 60 ? `Synced ${s} s ago` : `Synced ${Math.floor(s / 60)} min ago`;
}

export function BoardView() {
  const { bots, who } = useWho();
  const [boards, setBoards] = useState<KanbanBoardMeta[]>([]);
  const [slug, setSlug] = useState('');
  const [workflow, setWorkflow] = useState<KanbanWorkflow | null>(null);
  const [data, setData] = useState<KanbanBoardData | null>(null);
  const [links, setLinks] = useState<[string, string][]>([]);
  /** How many cards wait on each card, down the whole chain. */
  const blocking = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const [p, c] of links) kids.set(p, [...(kids.get(p) ?? []), c]);
    const out = new Map<string, number>();
    for (const id of kids.keys()) { const seen = new Set<string>(), todo = [...kids.get(id)!]; while (todo.length) { const x = todo.pop()!; if (!seen.has(x)) { seen.add(x); todo.push(...(kids.get(x) ?? [])); } } out.set(id, seen.size); }
    return out;
  }, [links]);
  const [offline, setOffline] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [, tick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [order, setOrder] = useState<CardOrder>(() => (lsGet('kanbanSort') === 'bot' ? 'bot' : 'hermes'));
  const pickOrder = (o: CardOrder) => { setOrder(o); lsSet('kanbanSort', o); };
  const [creating, setCreating] = useState<string | null>(null);
  const [pending, setPending] = useState<{ card: KanbanCard; to: string; plan: MovePlan } | null>(null);
  const cursor = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [tile, setTile] = useState<{ perRow: number; rowH: number | null }>({ perRow: 4, rowH: null });
  // One-job workers: the New worker form, and the list of them with what each has spent.
  const [newWorker, setNewWorker] = useState(false);
  const [workersOpen, setWorkersOpen] = useState(false);
  const [workersVersion, setWorkersVersion] = useState(0);
  // A card picked in Search opens once the board is here.
  const focusCard = useBoardFocus((s) => s.card);
  useEffect(() => { if (focusCard && data) { setOpenId(focusCard); useBoardFocus.setState({ card: null }); } }, [focusCard, data]);

  const say = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 8000);
  }, []);

  const reload = useCallback(async (board = slug) => {
    setSyncing(true);
    try {
      const [d, l] = await Promise.all([kanbanApi.board(board), kanbanApi.links(board).catch(() => ({ links: [] as [string, string][] }))]);
      cursor.current = d.latest_event_id;
      setData(d);
      setLinks(l.links);
      setOffline(null);
      setSyncedAt(Date.now());
    } catch (e) { setOffline((e as Error).message); }
    finally { setSyncing(false); }
  }, [slug]);

  useEffect(() => {
    kanbanApi.workflow().then(setWorkflow).catch((e) => setOffline((e as Error).message));
    kanbanApi.boards().then((r) => { setBoards(r.boards); setSlug((s) => s || r.current); }).catch(() => {});
  }, []);
  useEffect(() => { void reload(slug); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hermes's event counter: when it moves, something changed (in either app, or by an agent); then re-read the board.
  useEffect(() => {
    const t = setInterval(async () => {
      tick((n) => n + 1);
      if (document.visibilityState === 'hidden' || drag) return;
      try {
        const { latest_event_id } = await kanbanApi.cursor(slug);
        setOffline(null);
        if (latest_event_id !== cursor.current) await reload(slug);
        else setSyncedAt(Date.now());
      } catch (e) { setOffline((e as Error).message); }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [slug, drag, reload]);

  // The whole board in one view: columns wrap into balanced rows (8 columns at 1300 px: two rows of four), and
  // each row gets an equal share of the height, long columns scrolling inside. Too short a window: rows grow and
  // the board scrolls down instead.
  const colCount = workflow?.columns.length ?? 8;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = () => {
      const MIN = 250, GAP = 16, PAD_X = 48, PAD_Y = 26, MIN_ROW = 220;
      const fitsPerRow = Math.max(1, Math.min(colCount, Math.floor((el.clientWidth - PAD_X + GAP) / (MIN + GAP))));
      const rows = Math.ceil(colCount / fitsPerRow);
      const perRow = Math.ceil(colCount / rows);
      const rowH = Math.floor((el.clientHeight - PAD_Y - GAP * (rows - 1)) / rows);
      setTile({ perRow, rowH: rowH >= MIN_ROW ? rowH : null });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [colCount, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" jumps to search (when not typing somewhere).
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(el.tagName) && !el.isContentEditable) { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const allCards = useMemo(() => data?.columns.flatMap((c) => c.tasks) ?? [], [data]);
  const columns = useMemo(() => {
    if (!workflow || !data) return [];
    const byName = new Map(data.columns.map((c) => [c.name, c.tasks]));
    return workflow.columns.map((c) => {
      const cards = byName.get(c.key) ?? [];
      return { ...c, cards, shown: orderCards(c.key, cards.filter((t) => matches(t, filters)), order, who) };
    });
  }, [workflow, data, filters, order, who]);
  const filtering = isFiltering(filters);
  const total = allCards.length;
  const shownTotal = columns.reduce((n, c) => n + c.shown.length, 0);

  const priorities = useMemo(() => Array.from(new Set(allCards.map((c) => c.priority ?? 0).filter((p) => p !== 0))).sort((a, b) => b - a), [allCards]);
  const tenants = useMemo(() => Array.from(new Set(allCards.map((c) => c.tenant).filter(Boolean) as string[])).sort(), [allCards]);
  const people = useMemo(() => Array.from(new Set([...(data?.assignees ?? []), ...allCards.map((c) => c.assignee).filter(Boolean) as string[]])), [data, allCards]);

  /** Send a move to Hermes. The card shows in its new place at once; Hermes's answer settles it. */
  const doMove = useCallback(async (card: KanbanCard, to: string, extra: { summary?: string; block_reason?: string } = {}) => {
    const fromLabel = workflow?.columns.find((c) => c.key === card.status)?.label ?? card.status;
    setData((d) => d && ({ ...d, columns: d.columns.map((c) => {
      const rest = c.tasks.filter((t) => t.id !== card.id);
      if (c.name !== to) return { ...c, tasks: rest };
      const moved = { ...card, status: to };
      const at = landingIndex(to, moved, rest);
      return { ...c, tasks: [...rest.slice(0, at), moved, ...rest.slice(at)] };
    }) }));
    try {
      await kanbanApi.update(slug, card.id, { status: to, ...extra });
    } catch (e) {
      say(`Hermes didn’t move “${card.title}”: ${(e as Error).message}. It’s back in ${fromLabel}.`);
    }
    await reload();
    // A keyboard move re-creates the card in its column; keep the keyboard on it.
    if (document.activeElement === document.body) {
      document.querySelector<HTMLElement>(`.kb-card[data-id="${CSS.escape(card.id)}"] .kb-card__open`)?.focus();
    }
  }, [slug, reload, say, workflow]);

  /** Every move starts here: Hermes's rules first, then anything Hermes needs or does to an agent is asked for. */
  const requestMove = useCallback((card: KanbanCard, to: string) => {
    if (!canMove(workflow, card.status, to)) {
      const label = workflow?.columns.find((c) => c.key === to)?.label ?? to;
      say(`Hermes doesn’t allow moving a card from ${card.status} to ${label} by hand.`);
      return;
    }
    const plan = planMove(card, to, who);
    if (plan.needsSummary || plan.asksReason || plan.effects.length) setPending({ card, to, plan });
    else void doMove(card, to);
  }, [workflow, who, doMove, say]);

  const add = useCallback(async (column: string, title: string, key: string): Promise<string | null> => {
    try {
      const r = await kanbanApi.create(slug, { title, key, ...(column === 'triage' ? { triage: true } : {}) });
      // Hermes starts a card in Ready (or Triage); Todo is then one of Hermes's own moves.
      if (column === 'todo' && r.task && r.task.status === 'ready') await kanbanApi.update(slug, r.task.id, { status: 'todo' });
      if (r.warning) say(r.warning);
      await reload();
      return null;
    } catch (e) {
      return `Hermes didn’t add it: ${(e as Error).message}`;
    }
  }, [slug, reload, say]);

  /**
   * A card from the Add task dialog, and its chain: each step is its own card, linked to the one before, so Hermes keeps
   * it in Todo until that card is done and then hands it to its bot with the earlier result. Keys follow the dialog's
   * key, so sending again after a failure picks up the cards already made instead of adding them twice.
   */
  const addChain = useCallback(async (n: NewCard): Promise<string | null> => {
    const total = n.steps.length + 1;
    const bodyFor = (who: string, text: string) => (isOwner(who) ? text : [text, BOT_RULES].filter(Boolean).join('\n\n'));
    let made = 0;
    try {
      const first = await kanbanApi.create(slug, {
        title: n.title, key: n.key, body: n.assignee ? bodyFor(n.assignee, n.body) : n.body || undefined,
        ...(n.assignee ? { assignee: n.assignee } : {}), ...(n.column === 'triage' ? { triage: true } : {}),
      });
      if (!first.task) throw new Error('no card came back');
      made = 1;
      if (n.column === 'todo' && first.task.status === 'ready') await kanbanApi.update(slug, first.task.id, { status: 'todo' });
      if (first.warning) say(first.warning);
      let prev = first.task.id;
      for (const [i, s] of n.steps.entries()) {
        const name = who(s.who);
        const what = s.what.trim() || (isOwner(s.who)
          ? 'Check the result of the step before. Move this card to Done to let the chain go on; to send it back, comment and move the earlier card to Ready.'
          : 'Carry on from the step before: read its result and do your part.');
        const r = await kanbanApi.create(slug, {
          title: `${n.title} · step ${i + 2} of ${total}: ${isOwner(s.who) ? 'your review' : name}`,
          key: `${n.key}-s${i + 2}`, assignee: s.who, parents: [prev], body: bodyFor(s.who, what),
        });
        if (!r.task) throw new Error('no card came back');
        prev = r.task.id;
        made += 1;
      }
      await reload();
      return null;
    } catch (e) {
      await reload();
      return made
        ? `Hermes added ${made} of ${total} cards, then stopped: ${(e as Error).message}. Add task again to finish (the ${made} already made aren’t repeated).`
        : `Hermes didn’t add it: ${(e as Error).message}`;
    }
  }, [slug, reload, say, who]);

  // ---------- drag and drop ----------
  const dragStart = (card: KanbanCard) => (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', card.id);
    e.dataTransfer.effectAllowed = 'move';
    setDrag({ id: card.id, from: card.status });
  };
  const dragEnd = () => { setDrag(null); setOver(null); };
  /** Near an edge while dragging, the board (and a long column) scrolls by itself. */
  const edgeScroll = (e: DragEvent) => {
    const el = scroller.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const edge = 72;
    if (e.clientX < r.left + edge) el.scrollLeft -= Math.ceil((r.left + edge - e.clientX) / 4);
    else if (e.clientX > r.right - edge) el.scrollLeft += Math.ceil((e.clientX - (r.right - edge)) / 4);
    if (e.clientY < r.top + edge) el.scrollTop -= Math.ceil((r.top + edge - e.clientY) / 4);
    else if (e.clientY > r.bottom - edge) el.scrollTop += Math.ceil((e.clientY - (r.bottom - edge)) / 4);
    const list = (e.target as HTMLElement).closest?.('.kb-col__cards') as HTMLElement | null;
    if (list) {
      const lr = list.getBoundingClientRect();
      if (e.clientY < lr.top + 40) list.scrollTop -= 10;
      else if (e.clientY > lr.bottom - 40) list.scrollTop += 10;
    }
  };
  const dragged = drag ? allCards.find((c) => c.id === drag.id) ?? null : null;

  const closeDrawer = useCallback(() => {
    const id = openId;
    setOpenId(null);
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`.kb-card[data-id="${CSS.escape(id)}"] .kb-card__open`)?.focus());
  }, [openId]);

  if (offline && !data) {
    return (
      <main className="chat kb-view">
        <div className="kb-main">
          <header className="kb-head"><div className="kb-head__title"><h1>Kanban</h1></div></header>
          <div className="kb-state"><div className="cfg-error">Couldn’t open Hermes’s board: {offline}</div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void reload()}>Try again</button></div>
        </div>
      </main>
    );
  }

  const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const chips: { label: string; clear: () => void }[] = [
    ...(filters.priority ? [{ label: `Priority: ${filters.priority === PRIORITISED ? 'any set' : `P${filters.priority}`}`, clear: () => setF({ priority: null }) }] : []),
    ...(filters.tenant ? [{ label: `Tenant: ${filters.tenant}`, clear: () => setF({ tenant: null }) }] : []),
  ];

  return (
    <main className={`chat kb-view${openId ? ' has-drawer' : ''}`}>
      <div className="kb-main">
        <header className="kb-head">
          <div className="kb-head__title">
            <h1>Kanban</h1>
            {boards.length > 1 && (
              <select className="text-input kb-head__switch" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Board">
                {boards.map((b) => <option key={b.slug} value={b.slug}>{b.name || b.slug}</option>)}
              </select>
            )}
            <span className={`kb-head__sub${offline ? ' is-off' : ''}`} role="status">
              {offline ? `Can’t reach Hermes: ${offline}. Showing the board as last loaded.` : `Hermes’s task board · ${total} ${total === 1 ? 'task' : 'tasks'}${syncedAt ? ` · ${syncedText(syncedAt)}` : ''}`}
            </span>
          </div>
          <div className="kb-head__acts">
            <button type="button" className={`icon-btn kb-refresh${syncing ? ' is-busy' : ''}`} aria-label="Refresh from Hermes" title="Refresh from Hermes" onClick={() => void reload()} disabled={syncing}>
              <Icon name="refresh" size={14} />
            </button>
            <div className="kb-filter">
              <button type="button" className="cfg-btn cfg-btn--secondary kb-filter__btn" aria-expanded={workersOpen} onClick={() => setWorkersOpen((o) => !o)} title="One-job workers and what each has spent">
                Workers
              </button>
              {workersOpen && (
                <WorkersPopover who={who} version={workersVersion} onClose={() => setWorkersOpen(false)} onOpen={(card) => { setWorkersOpen(false); setOpenId(card); }} />
              )}
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary kb-filter__btn" onClick={() => setNewWorker(true)} title="One job for one team member, with a spending cap">
              <Icon name="plus" size={12} /> <span>New worker</span>
            </button>
            <button type="button" className="cfg-btn cfg-btn--primary kb-head__add" onClick={() => setCreating('ready')} disabled={!workflow}>
              <Icon name="plus" size={12} /> <span>Add task</span>
            </button>
          </div>
        </header>
        <p className="kb-how">
          The column is the signal: a card in <b>Ready</b> goes to its bot, which works it and finishes in <b>Done</b> or <b>Review</b>.
          A card can hand on to a next step (another bot, or <b>You</b> to check it first), which starts once the card before it is done.
        </p>

        <div className="kb-tools" role="search">
          <label className="kb-search">
            <Icon name="search" size={13} opacity={0.6} />
            <input ref={search} type="search" value={filters.q} placeholder="Search tasks…" aria-label="Search tasks by title or ID"
              onChange={(e) => setF({ q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape' && filters.q) { e.stopPropagation(); setF({ q: '' }); } }} />
          </label>
          <label className="routines-pick kb-pick">
            <span>Bot</span>
            <select value={filters.assignee ?? ''} onChange={(e) => setF({ assignee: e.target.value || null })} aria-label="Filter tasks by bot">
              <option value="">All bots</option>
              {people.map((p) => <option key={p} value={p}>{who(p)}</option>)}
              <option value={UNASSIGNED}>Unassigned</option>
            </select>
          </label>
          <label className="routines-pick kb-pick">
            <span>Sort</span>
            <select value={order} onChange={(e) => pickOrder(e.target.value as CardOrder)} aria-label="Sort cards">
              <option value="hermes">Hermes order</option>
              <option value="bot">Bot</option>
            </select>
          </label>
          <div className="kb-filter">
            <button type="button" className={`cfg-btn cfg-btn--secondary kb-filter__btn${chips.length ? ' is-on' : ''}`} aria-expanded={filterOpen} aria-controls="kb-filters"
              onClick={() => setFilterOpen((o) => !o)}>
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M2 3.5h12M4.5 8h7M7 12.5h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>
              Filters{chips.length ? ` · ${chips.length}` : ''}
            </button>
            {filterOpen && (
              <div id="kb-filters" className="kb-filter__pop" role="group" aria-label="Filters"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFilterOpen(false); } }}>
                <label className="cfg-field">
                  <span className="cfg-field__label">Priority</span>
                  <select className="text-input" value={filters.priority ?? ''} onChange={(e) => setF({ priority: e.target.value || null })} autoFocus>
                    <option value="">Any</option>
                    <option value={PRIORITISED}>Has a priority</option>
                    {priorities.map((p) => <option key={p} value={String(p)}>P{p}</option>)}
                    <option value="0">No priority (0)</option>
                  </select>
                </label>
                {tenants.length > 0 && (
                  <label className="cfg-field">
                    <span className="cfg-field__label">Tenant</span>
                    <select className="text-input" value={filters.tenant ?? ''} onChange={(e) => setF({ tenant: e.target.value || null })}>
                      <option value="">Any</option>
                      {tenants.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                )}
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setFilterOpen(false)}>Done</button>
              </div>
            )}
          </div>
          {chips.map((c) => (
            <span key={c.label} className="kb-fchip">{c.label}<button type="button" aria-label={`Remove ${c.label}`} onClick={c.clear}><Icon name="close" size={10} /></button></span>
          ))}
          {filtering && (
            <>
              <span className="kb-tools__count" role="status">{shownTotal} of {total} shown</span>
              <button type="button" className="kb-clear" onClick={() => { setFilters(NO_FILTERS); setFilterOpen(false); }}>Clear filters</button>
            </>
          )}
        </div>

        {!workflow || !data ? <div className="kb-state"><div className="cfg-empty">Opening Hermes’s board…</div></div> : (
          <div className="kb-scroll" ref={scroller} onDragOver={drag ? edgeScroll : undefined}>
            <div className="kb-columns" style={{ '--kb-per-row': tile.perRow, '--kb-row-h': tile.rowH ? `${tile.rowH}px` : 'none' } as CSSProperties}>
              {columns.map((col) => {
                const canDrop = !!drag && canMove(workflow, drag.from, col.key);
                const state = !drag ? '' : drag.from === col.key ? ' is-source' : canDrop ? ' is-target' : ' is-closed';
                const markerAt = canDrop && over === col.key && dragged ? landingIndex(col.key, dragged, col.shown, order, who) : -1;
                const count = filtering ? `${col.shown.length} of ${col.cards.length}` : String(col.cards.length);
                return (
                  <section key={col.key} className={`kb-col${state}${over === col.key && canDrop ? ' is-over' : ''}`} data-s={col.key}
                    aria-label={`${col.label}, ${count} tasks`}
                    onDragOver={(e) => { if (!canDrop) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== col.key) setOver(col.key); }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col.key ? null : o)); }}
                    onDrop={(e) => { e.preventDefault(); const card = dragged; dragEnd(); if (card && canDrop) requestMove(card, col.key); }}>
                    <header className="kb-col__head" title={COLUMN_HINT[col.key] ?? ''}>
                      <span className="kb-col__dot" aria-hidden />
                      <h2 className="kb-col__name">{col.label}</h2>
                      <span className="kb-col__count">{count}</span>
                      {ADDABLE.includes(col.key) && (
                        <button type="button" className="icon-btn icon-btn--plain kb-col__plus" aria-label={`Add task to ${col.label}`} onClick={() => setCreating(col.key)}><Icon name="plus" size={12} /></button>
                      )}
                    </header>
                    {drag && drag.from !== col.key && !canDrop && <div className="kb-col__no">Hermes doesn’t take this move</div>}
                    {drag && drag.from === col.key && <div className="kb-col__no">Order here follows priority, then age</div>}
                    <div className="kb-col__cards">
                      {col.shown.map((card, i) => (
                        <div key={card.id} className="kb-slot">
                          {markerAt === i && <div className="kb-marker" aria-hidden />}
                          <TaskCard card={card} blocking={blocking.get(card.id) ?? 0} bots={bots} workflow={workflow} who={who} dragging={drag?.id === card.id} open={openId === card.id}
                            onOpen={() => setOpenId(card.id)} onMove={(to) => requestMove(card, to)} onDragStart={dragStart(card)} onDragEnd={dragEnd} />
                        </div>
                      ))}
                      {markerAt >= col.shown.length && <div className="kb-marker" aria-hidden />}
                      {canDrop && over === col.key && <div className="kb-drop">Drop to move to {col.label}</div>}
                      {!col.cards.length && !canDrop && <div className="kb-col__empty">{COLUMN_HINT[col.key] ?? 'No tasks'}</div>}
                      {!!col.cards.length && !col.shown.length && <div className="kb-col__empty">No matching tasks here.</div>}
                    </div>
                    {ADDABLE.includes(col.key) && <QuickAdd column={col.label} onAdd={(t, k) => add(col.key, t, k)} />}
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {toast && (
          <div className="kb-toast" role="alert">
            <span>{toast}</span>
            <button type="button" className="icon-btn icon-btn--plain" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" size={12} /></button>
          </div>
        )}
      </div>

      {openId && workflow && (
        <TaskDrawer board={slug} id={openId} version={data?.latest_event_id ?? 0} workflow={workflow} bots={bots} who={who} assignees={data?.assignees ?? []}
          onClose={closeDrawer} onChanged={() => void reload()} onMove={(card, to) => requestMove(card, to)} />
      )}
      {newWorker && (
        <NewWorkerDialog bots={bots} onClose={() => setNewWorker(false)}
          onMade={(w) => { setNewWorker(false); setWorkersVersion((v) => v + 1); say(`Worker started: “${w.title}”, with a $${w.capUsd.toFixed(2)} cap.`); void reload(); }} />
      )}
      {creating && workflow && <CreateDialog workflow={workflow} column={creating} people={people} who={who} onCreate={addChain} onBrief={(p) => kanbanApi.brief(slug, p)} onClose={() => setCreating(null)} />}
      {pending && (
        <MoveDialog card={pending.card} toLabel={workflow?.columns.find((c) => c.key === pending.to)?.label ?? pending.to} plan={pending.plan}
          onCancel={() => setPending(null)} onConfirm={(extra) => { const p = pending; setPending(null); void doMove(p.card, p.to, extra); }} />
      )}
    </main>
  );
}
