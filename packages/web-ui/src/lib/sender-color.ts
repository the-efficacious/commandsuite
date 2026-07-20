/**
 * Sender color — two-tone on the paper surface: the viewer's own
 * name renders in steel (brand primary), everyone else in ember
 * (the warm accent). Binary split keeps the transcript readable
 * without rainbow noise and cleanly distinguishes self from team.
 */

export function senderTextClass(sender: string, viewer: string): string {
  return sender === viewer ? 'text-brand-steel' : 'text-brand-ember';
}
