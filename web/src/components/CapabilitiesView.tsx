import { useStore } from '../store';
import { SidebarOrb } from './SidebarOrb';

/**
 * Capabilities (sidebar › Capabilities): Zubi's orb and the ring of what it can do, opened like Tasks and Kanban
 * instead of sitting in the sidebar. The orb is the same live one: it shows what Zubi is doing, and each capability
 * opens its window or starts a request.
 */
export function CapabilitiesView() {
  const primary = useStore((s) => s.bots.find((b) => b.isPrimary));
  return (
    <main className="chat cap-view">
      <header className="tasks-view__header">
        <div className="cap-view__title">
          <div className="tasks-view__title">Capabilities</div>
          <span className="cap-view__sub">What {primary?.name ?? 'Zubi'} can do. Click one to open it or ask for it.</span>
        </div>
      </header>
      <div className="cap-view__stage">
        <SidebarOrb />
      </div>
    </main>
  );
}
