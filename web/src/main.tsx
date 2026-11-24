import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// HeyZubi type, bundled with the app (no font requests to other sites).
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/details.css';
import './styles/modals.css';
import './styles/viewer.css';
import './styles/voice.css';
// Last: the Pearl, Sand and Obsidian palettes build on tokens.css (configStore.ts THEMES).
import './styles/themes.css';
import './styles/float.css'; // floating windows: glass, bright edge, deep shadow (after the themes)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
