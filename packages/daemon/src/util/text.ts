// CSI, OSC (BEL- or ST-terminated) and single-character escape sequences.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Removes terminal escape codes and normalizes line endings for model consumption. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Keeps the head and tail of long output. Errors tend to be at the end and
 * the command's context at the start; the middle of an install log is noise.
 */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n... [${omitted} characters omitted] ...\n${s.slice(s.length - tail)}`;
}
