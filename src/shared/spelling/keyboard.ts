// Keyboard layouts, for judging how likely a typo is: hitting a neighbouring
// key is a common slip, hitting a key on the other side of the keyboard is not.

export type KeyboardLayout = 'qwerty' | 'qwertz' | 'azerty';
export const KEYBOARD_LAYOUTS: KeyboardLayout[] = ['qwerty', 'qwertz', 'azerty'];

/** Letter rows, top to bottom. Each row sits about half a key to the right of the one above. */
const ROWS: Record<KeyboardLayout, string[]> = {
  qwerty: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  qwertz: ['qwertzuiopü', 'asdfghjklöä', 'yxcvbnm'],
  azerty: ['azertyuiop', 'qsdfghjklmù', 'wxcvbn'],
};

/**
 * Letters that trade places when a national layout and the US layout get mixed
 * up (the system set to one, the keys printed with the other, or switching
 * between them): "zou" for "you" on a German keyboard.
 */
const LAYOUT_SWAPS: Record<KeyboardLayout, [string, string][]> = {
  qwerty: [],
  qwertz: [['y', 'z']],
  azerty: [['a', 'q'], ['z', 'w']],
};

const neighbourCache = new Map<KeyboardLayout, Map<string, Set<string>>>();

function neighbourMap(layout: KeyboardLayout): Map<string, Set<string>> {
  let map = neighbourCache.get(layout);
  if (map) return map;
  map = new Map();
  const rows = ROWS[layout];
  const add = (a: string | undefined, b: string | undefined) => {
    if (!a || !b) return;
    if (!map!.has(a)) map!.set(a, new Set());
    map!.get(a)!.add(b);
  };
  rows.forEach((row, r) => {
    [...row].forEach((ch, i) => {
      add(ch, row[i - 1]);
      add(ch, row[i + 1]);
      add(ch, rows[r - 1]?.[i]);
      add(ch, rows[r - 1]?.[i + 1]);
      add(ch, rows[r + 1]?.[i - 1]);
      add(ch, rows[r + 1]?.[i]);
    });
  });
  neighbourCache.set(layout, map);
  return map;
}

/** True if the two letters are next to each other on the keyboard. */
export function areNeighbours(a: string, b: string, layout: KeyboardLayout): boolean {
  return neighbourMap(layout).get(a)?.has(b) ?? false;
}

/** True if typing one letter for the other is a layout mix-up (y and z on QWERTZ). */
export function isLayoutSwap(a: string, b: string, layout: KeyboardLayout): boolean {
  return LAYOUT_SWAPS[layout].some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** The layout a locale such as "de-AT" or "fr" usually types on. */
export function layoutForLocale(locale: string | undefined): KeyboardLayout {
  const l = (locale ?? '').toLowerCase();
  const [lang, region] = l.split(/[-_]/);
  if (lang === 'fr' && region !== 'ca' && region !== 'ch') return 'azerty';
  if (region === 'be') return 'azerty';
  if (['de', 'cs', 'sk', 'hu', 'sl', 'hr', 'bs', 'sr', 'sq'].includes(lang ?? '')) return 'qwertz';
  if (region === 'ch' || region === 'at' || region === 'li') return 'qwertz';
  return 'qwerty';
}
