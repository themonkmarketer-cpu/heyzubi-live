import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Repairs damaged pictures in a bot's stored conversation (Hermes's response_store.db in its home).
 *
 * Hermes hides anything in a tool result that looks like a key ("***", "..."). Screenshots travel in tool results as
 * base64, and a long run of base64 can look like a key, so a picture sometimes gets masked and is no longer valid
 * base64. The model's API then refuses every later turn of that conversation ("image.source.base64: invalid base64
 * data"), because the whole history is sent each time. This swaps each damaged picture for a short note; everything
 * else in the conversation stays as it was.
 */

export const DAMAGED_IMAGE_ERROR = /image\.source\.base64|invalid base64 data|Could not process image/i;

const NOTE = '[A screenshot was here, but its picture data was damaged when it was saved, so it was removed. Take a new screenshot if you need to see that page again.]';
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

const valid = (data: unknown) => typeof data === 'string' && data.length > 0 && data.length % 4 === 0 && B64.test(data);

/** The base64 of a picture block, in the shapes Hermes stores (OpenAI image_url data URL, Anthropic image source). */
function pictureData(block: any): string | null | undefined {
  if (!block || typeof block !== 'object') return undefined;
  if (block.type === 'image_url' || block.type === 'input_image') {
    const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    if (typeof url !== 'string' || !url.startsWith('data:')) return undefined; // a link, not inline data
    return url.split(',', 2)[1] ?? null;
  }
  if (block.type === 'image' && block.source?.type === 'base64') return block.source.data ?? null;
  return undefined;
}

/** Fix the damaged pictures in one conversation item list, in place. Returns how many were replaced. */
function fixList(list: any[]): number {
  let fixed = 0;
  for (const item of list) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (block?.type === 'tool_result' && Array.isArray(block.content)) { fixed += fixList([block]); continue; }
      const data = pictureData(block);
      if (data === undefined || valid(data)) continue;
      content[i] = { type: 'text', text: NOTE };
      fixed++;
    }
  }
  return fixed;
}

/** Replace every damaged picture in the bot's stored conversations. Returns how many were replaced (0 = nothing to do). */
export function repairDamagedImages(home: string | null): number {
  if (!home) return 0;
  const file = path.join(home, 'response_store.db');
  if (!fs.existsSync(file)) return 0;
  const db = new Database(file, { timeout: 15_000 });
  let fixed = 0;
  try {
    const rows = db.prepare('SELECT response_id, data FROM responses').all() as { response_id: string; data: string }[];
    const save = db.prepare('UPDATE responses SET data=? WHERE response_id=?');
    db.transaction(() => {
      for (const r of rows) {
        let d: any;
        try { d = JSON.parse(r.data); } catch { continue; }
        const n = Array.isArray(d?.conversation_history) ? fixList(d.conversation_history) : 0;
        if (n) { save.run(JSON.stringify(d), r.response_id); fixed += n; }
      }
    })();
  } finally { db.close(); }
  return fixed;
}
