// The gender of a team member's persona, as the owner chose it. A leaf file: engine.ts and team.ts import each other.
export const GENDERS = ['female', 'male', 'neutral'] as const;
export type Gender = (typeof GENDERS)[number];
export const isGender = (v: unknown): v is Gender => GENDERS.includes(v as Gender);
const PRONOUNS: Record<Gender, string> = { female: 'she/her', male: 'he/him', neutral: 'they/them' };
/** "Your persona is female (she/her).", or '' when it was never said. */
export const personaLine = (g: unknown) => (isGender(g) ? `Your persona is ${g} (${PRONOUNS[g]}).` : '');
export const pronouns = (g: unknown) => (isGender(g) ? PRONOUNS[g] : '');
