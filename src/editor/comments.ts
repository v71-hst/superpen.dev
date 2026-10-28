// Canvas comments: pinned threads stored in the document (`comments`), readable and answerable by MCP agents.
import { useStore } from './store';
import { currentTree } from './tree';
import { worldRectOf } from './ops';
import { allIds, newId } from '../model/doc';
import type { PenDoc } from '../model/types';

export type CommentMsg = { author: 'user' | 'agent'; name?: string; text: string; t: number };
/** Pinned at world (x, y); when `node` is set the pin follows that node (dx/dy from its top-left). */
export type PenComment = { id: string; node?: string; dx?: number; dy?: number; x: number; y: number; messages: CommentMsg[]; resolved?: boolean };

export function commentsOf(doc: PenDoc | null): PenComment[] {
  return Array.isArray(doc?.comments) ? (doc!.comments as PenComment[]) : [];
}

/** Where a pin is drawn now (follows its node if that still exists). */
export function commentPos(c: PenComment): { x: number; y: number } {
  if (c.node && currentTree()?.byKey.has(c.node)) {
    const r = worldRectOf(c.node);
    if (r) return { x: r.x + (c.dx ?? 0), y: r.y + (c.dy ?? 0) };
  }
  return { x: c.x, y: c.y };
}

export function addComment(at: { x: number; y: number }, node: string | null): string {
  const r = node ? worldRectOf(node) : null;
  let id = '';
  useStore.getState().edit(d => {
    id = 'c' + newId(allIds(d));
    const list = ((d as any).comments ??= []) as PenComment[];
    list.push({ id, ...(node && r ? { node, dx: Math.round(at.x - r.x), dy: Math.round(at.y - r.y) } : {}), x: Math.round(at.x), y: Math.round(at.y), messages: [] });
  });
  return id;
}

function update(id: string, fn: (c: PenComment, list: PenComment[]) => void) {
  useStore.getState().edit(d => {
    const list = commentsOf(d);
    const c = list.find(x => x.id === id);
    if (c) fn(c, list);
  });
}

export function postMessage(id: string, msg: CommentMsg) {
  update(id, c => {
    c.messages.push(msg);
    if (msg.author === 'user') c.resolved = false;
  });
}

export function setResolved(id: string, resolved: boolean) {
  update(id, c => {
    if (resolved) c.resolved = true;
    else delete c.resolved;
  });
}

export function deleteComment(id: string) {
  useStore.getState().edit(d => {
    const list = commentsOf(d);
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete (d as any).comments;
  });
}

/** Comments with no messages are drafts the user abandoned. */
export function dropIfEmpty(id: string) {
  const c = commentsOf(useStore.getState().doc).find(x => x.id === id);
  if (c && !c.messages.length) deleteComment(id);
}

/** Open threads where the user spoke last: work for the agent. */
export function openForAgent(doc: PenDoc | null) {
  return commentsOf(doc).filter(c => !c.resolved && c.messages.length && c.messages[c.messages.length - 1].author === 'user');
}
