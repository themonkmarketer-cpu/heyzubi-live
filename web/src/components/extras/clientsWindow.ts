import { create } from 'zustand';

/** The Clients window: open or not, and the client to show first (from a search hit). */
export const useClientsWindow = create<{ open: boolean; focus: string | null }>(() => ({ open: false, focus: null }));
export const openClients = (focus: string | null = null) => useClientsWindow.setState({ open: true, focus });
export const closeClients = () => useClientsWindow.setState({ open: false, focus: null });

/** A Kanban card to open when the board shows (from a search hit). */
export const useBoardFocus = create<{ card: string | null }>(() => ({ card: null }));
