import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { giveToHermes } from './engine.js';

/**
 * Skills HeyZubi gives the main agent (Zubi), so its flows match what the app can do. Installed into the main Hermes
 * home's skills folder at start-up and rewritten only when the text here changes. Hermes picks skills up by their
 * description; the body is the procedure.
 */

const ADD_MEMBER = `---
name: team-app-add-member
description: Use when the owner asks to add, build, create or hire a new bot, agent or team member (sales, marketing, support, research and so on), including one built from a course, lesson, repo or document.
---

# Adding a team member in HeyZubi

Everything happens inside HeyZubi. The owner never needs a terminal, the Hermes CLI, the Hermes app or another website, apart from Claude's own Authorize page that the card opens.

Tools (HeyZubi's hq server; deferred: find with tool_search, load with tool_describe, call with tool_call):
- \`mcp__hq__create_team_member\` makes the member in HeyZubi and its Hermes profile (same name, mascot and description in both), and puts a setup card in this chat.
- \`mcp__hq__team_member_status\` says where a member stands and the next step.
- \`mcp__hq__ask_user\` and \`mcp__hq__send_to_bot\`.

Never use \`hermes profile create\`, copy another profile, or write into a profile before create_team_member has made it. A profile made outside HeyZubi is missing from the app and has no sign-in of its own (that is what went wrong with Mark on 2026-11-24).

## Steps: one at a time, short messages

1. **Understand the role.** If the owner gave a source (lesson, repo, doc), read it first and check that nothing in it runs code you haven't read or holds secrets.
2. **Draft:**
   - name: a short first name; ask if none was given;
   - role: one or two words, for example "Sales";
   - description: one or two sentences on what it owns, ending with "Never sends, posts, spends or changes outside systems without approval.";
   - mascot: from the tool's list, matching the role (trend for sales, megaphone for marketing, lifebuoy for support, magnifier for research);
   - persona: the SOUL.md text. Say who it is, that Zubi is the chief of staff who hands it work and approvals, and who else is on the team by name. Cover how it works and its approval rules.
3. **Confirm with ask_user.** Put the name and role, the description and the mascot in the question, with the options "Create <name>" and "Change something".
4. **Create.** Call create_team_member. It takes about a minute (it waits for the Hermes profile) and returns hermes_profile and skills_folder.
5. **Skills (only if the source has them).** Copy each reviewed skill folder into skills_folder, then call team_member_status to see them listed.
6. **Hand over to the card.** Tell the owner in one or two lines: "<name> is set up in HeyZubi and Hermes. Tap **Sign in <name> to Claude** on the card above. Claude opens in a new tab: click Authorize, copy the code, and paste it into the card." Then stop and wait.
7. **When you're told the owner signed in** (a message from the app), send the new member a one-line hello with send_to_bot. When it replies, tell the owner that it's ready and in the sidebar, and name one or two first tasks it could take.
8. **If something didn't work,** call team_member_status and follow its next_step. If the owner chose "Later", say once that the sign-in is in the member's settings (Engine) and leave it.

## Rules

- The Claude sign-in is the owner's own. Never do it for them, and never ask for the code or a password in the chat. Each member signs in with its own sign-in, never Zubi's.
- One member at a time unless the owner asks for more. If the app says the team is full, say so.
- The owner can change the persona, description and skills later in the member's settings (Hermes profile).
`;

const SKILLS: Record<string, string> = { 'team-app-add-member': ADD_MEMBER };

export function installZubiSkills() {
  const root = path.join(env.hermesHome, 'skills');
  if (!fs.existsSync(root)) return;
  for (const [name, text] of Object.entries(SKILLS)) {
    try {
      const dir = path.join(root, name);
      const file = path.join(dir, 'SKILL.md');
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text);
      giveToHermes(dir);
      console.log(`[skills] Zubi's ${name} skill installed`);
    } catch (e) {
      console.warn(`[skills] ${name}: ${(e as Error).message}`);
    }
  }
}
