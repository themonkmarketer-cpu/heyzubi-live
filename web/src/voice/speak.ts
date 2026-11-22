// Reading a bot's reply aloud: one at a time, with standalone text to speech (billed per character, far cheaper
// than a live call). The Listen button on a reply and the auto-play after a voice message both come here.
import { create } from 'zustand';
import { voiceApi } from './api';

interface SpeakState { key: string | null; phase: 'idle' | 'loading' | 'playing'; error: string | null }
export const useSpeak = create<SpeakState>(() => ({ key: null, phase: 'idle', error: null }));

let audio: HTMLAudioElement | null = null;
let url: string | null = null;
let ticket = 0;

export function stopSpeaking() {
  ticket++;
  if (audio) { audio.pause(); audio.src = ''; audio = null; }
  if (url) { URL.revokeObjectURL(url); url = null; }
  useSpeak.setState({ key: null, phase: 'idle' });
}

/** Read `text` aloud in the bot's voice. `key` names what is playing (a row), so its button can show it. */
export async function speakReply(botId: string, text: string, key: string): Promise<void> {
  stopSpeaking();
  const mine = ++ticket;
  useSpeak.setState({ key, phase: 'loading', error: null });
  try {
    const blob = await voiceApi.speak(botId, text);
    if (mine !== ticket) return;
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.onended = () => { if (mine === ticket) stopSpeaking(); };
    audio.onerror = () => { if (mine === ticket) stopSpeaking(); };
    await audio.play();
    useSpeak.setState({ phase: 'playing' });
  } catch (e) {
    if (mine !== ticket) return;
    stopSpeaking();
    useSpeak.setState({ error: (e as Error).message || 'Could not read it aloud' });
  }
}
