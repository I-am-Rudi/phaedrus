// ProseMirror plugin holding the underlined ranges. Ranges are mapped through
// every edit so they stay on the right words while you type.
//  - grammar/spelling ranges shrink on edits and vanish once their text changes
//  - style ranges grow with edits at their edges, so a teacher-mode revision
//    stays inside the tracked region until it gets feedback

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Category } from '@shared/types';

export interface IssueRange {
  id: string;
  category: Category;
  from: number;
  to: number;
  /** Text when the issue was found; grammar issues are dropped once it changes. */
  text: string;
  /** Hidden ranges keep being tracked but are not drawn (teacher mode, silent moves). */
  hidden?: boolean;
}

interface PluginState {
  items: IssueRange[];
  selected: string | null;
  decos: DecorationSet;
}

export type IssueMeta =
  | { type: 'replace'; kind: 'grammar' | 'style'; from: number; to: number; items: IssueRange[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'select'; id: string | null }
  | { type: 'visibility'; hidden: Record<string, boolean> }
  | { type: 'clear' };

export const issuesKey = new PluginKey<PluginState>('issues');

const isGrammar = (c: Category) => c !== 'style';

function build(doc: PMNode, items: IssueRange[], selected: string | null): DecorationSet {
  const decos = items
    .filter((i) => !i.hidden && i.from < i.to && i.to <= doc.content.size)
    .map((i) =>
      Decoration.inline(i.from, i.to, {
        class: `issue issue-${i.category}${i.id === selected ? ' issue-selected' : ''}`,
        'data-issue-id': i.id,
      }),
    );
  return DecorationSet.create(doc, decos);
}

function mapItems(items: IssueRange[], tr: Transaction): IssueRange[] {
  const out: IssueRange[] = [];
  for (const it of items) {
    const grammar = isGrammar(it.category);
    const from = tr.mapping.map(it.from, grammar ? 1 : -1);
    const to = tr.mapping.map(it.to, grammar ? -1 : 1);
    if (grammar) {
      if (from >= to || tr.doc.textBetween(from, to, '\n') !== it.text) continue;
    } else if (from > to) {
      continue;
    }
    out.push({ ...it, from, to });
  }
  return out;
}

export function createIssuesPlugin(onClick: (id: string | null) => void) {
  return new Plugin<PluginState>({
    key: issuesKey,
    state: {
      init: (_, state) => ({ items: [], selected: null, decos: DecorationSet.create(state.doc, []) }),
      apply(tr, prev) {
        const meta = tr.getMeta(issuesKey) as IssueMeta | undefined;
        let items = tr.docChanged ? mapItems(prev.items, tr) : prev.items;
        let selected = prev.selected;
        if (meta?.type === 'replace') {
          const keep = items.filter(
            (i) => (meta.kind === 'grammar' ? !isGrammar(i.category) : isGrammar(i.category)) || i.to <= meta.from || i.from >= meta.to,
          );
          items = [...keep, ...meta.items];
        } else if (meta?.type === 'remove') {
          items = items.filter((i) => !meta.ids.includes(i.id));
        } else if (meta?.type === 'select') {
          selected = meta.id;
        } else if (meta?.type === 'visibility') {
          items = items.map((i) => (i.id in meta.hidden ? { ...i, hidden: meta.hidden[i.id] } : i));
        } else if (meta?.type === 'clear') {
          items = [];
        }
        if (selected && !items.some((i) => i.id === selected)) selected = null;
        if (!tr.docChanged && !meta) return prev;
        return { items, selected, decos: build(tr.doc, items, selected) };
      },
    },
    props: {
      decorations: (state) => issuesKey.getState(state)?.decos,
      handleClick(view, pos) {
        const st = issuesKey.getState(view.state);
        const hit = st?.items.find((i) => !i.hidden && pos >= i.from && pos <= i.to);
        onClick(hit?.id ?? null);
        return false;
      },
    },
  });
}

export function IssuesExtension(onClick: (id: string | null) => void) {
  return Extension.create({
    name: 'issues',
    addProseMirrorPlugins: () => [createIssuesPlugin(onClick)],
  });
}

export function getIssues(state: EditorState): IssueRange[] {
  return issuesKey.getState(state)?.items ?? [];
}

// ------------------------------------------------------------ block helpers

export interface BlockInfo {
  index: number;
  /** Position of the block node. */
  pos: number;
  /** Position right after the block node. */
  end: number;
  type: 'heading' | 'paragraph';
  level: number;
  /** Plain text, hard breaks as "\n". */
  text: string;
  /** Document position of each character in `text`. */
  posAt(offset: number): number;
}

export function blocks(doc: PMNode): BlockInfo[] {
  const out: BlockInfo[] = [];
  doc.forEach((node, offset, index) => {
    const pos = offset;
    let text = '';
    const positions: number[] = [];
    node.descendants((child, childPos) => {
      const abs = pos + 1 + childPos;
      if (child.isText) {
        const t = child.text ?? '';
        for (let i = 0; i < t.length; i++) positions.push(abs + i);
        text += t;
      } else if (child.type.name === 'hardBreak') {
        positions.push(abs);
        text += '\n';
      }
      return true;
    });
    const contentEnd = pos + node.nodeSize - 1;
    out.push({
      index,
      pos,
      end: pos + node.nodeSize,
      type: node.type.name === 'heading' ? 'heading' : 'paragraph',
      level: (node.attrs.level as number) ?? 0,
      text,
      posAt: (o) => (o < positions.length ? positions[o]! : positions.length ? positions[positions.length - 1]! + 1 : contentEnd),
    });
  });
  return out;
}
