// The design skills served by the MCP server (list_design_skills / get_design_skill, and as MCP prompts). Each one is a
// Markdown file in this folder, bundled as text (esbuild --loader:.md=text). get_guide stays the format reference;
// these say how to design well with it.
import accessibility from './accessibility.md';
import colors from './colors.md';
import interfaceSkill from './interface.md';
import interfaceReview from './interface-review.md';
import layout from './layout.md';
import polish from './polish.md';
import transitions from './transitions.md';
import transitionsDev from './transitions-dev.md';
import typography from './typography.md';
import ui from './ui.md';
import unAi from './un-ai.md';
import writing from './writing.md';

export type DesignSkill = { name: string; title: string; when: string; text: string };

function skill(name: string, md: string): DesignSkill {
  const text = md.replace(/\r\n/g, '\n').trim();
  return {
    name,
    title: text.match(/^# (.+)$/m)?.[1] ?? name,
    when: (text.match(/^> Use when: ([\s\S]+?)\n\n/m)?.[1] ?? '').replace(/\s*\n>?\s*/g, ' '),
    text,
  };
}

// In the order a design is usually made: decide, build, finish.
export const SKILLS: DesignSkill[] = [
  skill('un-ai', unAi),
  skill('interface', interfaceSkill),
  skill('layout', layout),
  skill('typography', typography),
  skill('colors', colors),
  skill('ui', ui),
  skill('writing', writing),
  skill('transitions', transitions),
  skill('transitions-dev', transitionsDev),
  skill('accessibility', accessibility),
  skill('polish', polish),
  skill('interface-review', interfaceReview),
];

const ALIASES: Record<string, string> = {
  unai: 'un-ai', 'un-ai': 'un-ai', 'less-ai': 'un-ai', deslop: 'un-ai',
  a11y: 'accessibility', color: 'colors', colour: 'colors', colours: 'colors',
  type: 'typography', fonts: 'typography', copy: 'writing', 'ux-writing': 'writing', text: 'writing',
  review: 'interface-review', critique: 'interface-review', audit: 'interface-review',
  motion: 'transitions', animation: 'transitions', 'dev-transitions': 'transitions-dev', handoff: 'transitions-dev',
  components: 'ui', spacing: 'layout', ux: 'interface',
};

export function findSkill(name: string): DesignSkill | undefined {
  const key = name.trim().toLowerCase().replace(/^better[\s_-]+/, '').replace(/[\s_]+/g, '-');
  return SKILLS.find(s => s.name === key) ?? SKILLS.find(s => s.name === ALIASES[key]);
}

export const SKILL_INDEX = `# Design skills (Superpencil)

Short, specific guides for designing well in a .spen / .pen file. Load the ones that fit the task with
get_design_skill (several names in one call) BEFORE you design, and follow their "Check before you finish" lists.
get_guide is the format reference; these are about quality.

${SKILLS.map(s => `- ${s.name} (${s.title}): use when ${s.when}`).join('\n')}

Which to load:
- A new screen, page or flow from nothing: un-ai, interface, layout, typography, colors, ui, writing.
- Adding to or changing an existing design: layout, ui, plus typography / colors / writing for what you touch.
  Match the file's own variables and components first.
- "Make it look better / less generic / less AI": un-ai, then polish.
- Finishing, or "polish this": polish, accessibility.
- "Review / critique / audit this": interface-review (it calls on the others).
- Anything that moves, or a prototype: transitions; handing motion to code (CSS, Roblox): transitions-dev.
- Game UI (HUDs, menus, shops): each skill has game notes; un-ai's "Game UI" section first.

The user's own brand, references and instructions always win over a skill's defaults.`;
