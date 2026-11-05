// Teacher mode: revising one paragraph. While active, every other block is
// dimmed, edits and the cursor stay inside the paragraph, and nothing is sent
// for feedback until the revision is confirmed (or discarded, which puts the
// paragraph back as it was).

import { Extension } from '@tiptap/core';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface Revision {
  /** Range of the paragraph (block positions; grows if Enter splits it). */
  from: number;
  to: number;
  /** The paragraph as it was when the revision started, for Discard. */
  original: Slice;
}

type Meta = { start: Revision } | { stop: true };

export const revisionKey = new PluginKey<Revision | null>('revision');

export function getRevision(state: EditorState): Revision | null {
  return revisionKey.getState(state) ?? null;
}

/** Start revising the top-level block that contains `pos`. */
export function startRevision(state: EditorState, pos: number): Transaction | null {
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
  if ($pos.depth < 1) return null;
  const from = $pos.before(1);
  const to = $pos.after(1);
  const tr = state.tr.setMeta(revisionKey, { start: { from, to, original: state.doc.slice(from, to) } } satisfies Meta);
  // Keep the cursor where it is if it is already inside, otherwise put it at the start.
  if (state.selection.from < from || state.selection.to > to) tr.setSelection(TextSelection.create(tr.doc, from + 1));
  return tr.setMeta('addToHistory', false);
}

export function stopRevision(state: EditorState, discard = false): Transaction | null {
  const r = getRevision(state);
  if (!r) return null;
  const tr = state.tr;
  if (discard) tr.replace(r.from, r.to, r.original);
  return tr.setMeta(revisionKey, { stop: true } satisfies Meta);
}

function inside(r: { from: number; to: number }, a: number, b: number) {
  return a >= r.from && b <= r.to;
}

export const RevisionExtension = Extension.create({
  name: 'revision',
  // Above the hard-break shortcut, so Mod-Enter only finishes the revision
  // (the window key handler in the Write view does that) and adds no line break.
  priority: 1000,
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => !!getRevision(this.editor.state) };
  },
  addProseMirrorPlugins: () => [
    new Plugin<Revision | null>({
      key: revisionKey,
      state: {
        init: () => null,
        apply(tr, value) {
          const meta = tr.getMeta(revisionKey) as Meta | undefined;
          if (meta && 'start' in meta) return meta.start;
          if (meta && 'stop' in meta) return null;
          if (!value || !tr.docChanged) return value;
          const from = tr.mapping.map(value.from, -1);
          const to = tr.mapping.map(value.to, 1);
          return from < to ? { ...value, from, to } : null;
        },
      },
      // Only the paragraph under revision can change, and the cursor stays in it.
      filterTransaction(tr, state) {
        const r = getRevision(state);
        if (!r || tr.getMeta(revisionKey) || tr.getMeta('revision-allow')) return true;
        let ok = true;
        if (tr.docChanged) {
          for (const step of tr.steps) {
            step.getMap().forEach((a, b) => {
              if (!inside(r, a, b)) ok = false;
            });
            if (!ok) return false;
          }
        }
        if (tr.selectionSet) {
          const from = tr.mapping.map(r.from, -1);
          const to = tr.mapping.map(r.to, 1);
          const sel = tr.selection;
          if (sel.from < from + 1 || sel.to > to - 1) return false;
        }
        return ok;
      },
      props: {
        decorations(state) {
          const r = getRevision(state);
          if (!r) return null;
          const decos: Decoration[] = [];
          state.doc.forEach((node: PMNode, pos: number) => {
            const end = pos + node.nodeSize;
            const mine = pos >= r.from && end <= r.to;
            decos.push(Decoration.node(pos, end, { class: mine ? 'revising-block' : 'dimmed-block' }));
          });
          return DecorationSet.create(state.doc, decos);
        },
        attributes: (state): Record<string, string> => (getRevision(state) ? { class: 'in-revision' } : {}),
      },
    }),
  ],
});
