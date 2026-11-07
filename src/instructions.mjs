// Keeps agentbus's section in a global instructions file without touching the user's text.
const START = '<!-- herdr-agentbus:start -->';
const END = '<!-- herdr-agentbus:end -->';
const BLOCK = new RegExp(`\\s*${START}[\\s\\S]*?${END}\\s*`);

/** Returns `existing` with the section set to `body`, or removed when `body` is null. */
export function applyInstructions(existing, body) {
  const hasBlock = BLOCK.test(existing);
  if (body === null) {
    if (!hasBlock) return existing;
    const rest = existing.replace(BLOCK, '\n\n').trim();
    return rest ? `${rest}\n` : '';
  }
  const block = `${START}\n${body.trim()}\n${END}`;
  if (hasBlock) return `${existing.replace(BLOCK, `\n\n${block}\n\n`).trim()}\n`;
  const rest = existing.trim();
  return `${rest ? `${rest}\n\n` : ''}${block}\n`;
}

/** The part of the repository's AGENTS.md that tells an agent how to use the bus. */
export function agentInstructions(agentsMd) {
  const start = agentsMd.indexOf('# Working with the other agent');
  if (start < 0) throw new Error('AGENTS.md has no "Working with the other agent" section');
  return agentsMd.slice(start).replace(/\r\n/g, '\n');
}
