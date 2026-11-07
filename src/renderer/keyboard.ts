// Which keyboard layout the system types with. Chromium's Keyboard Map API
// reports what each physical key produces; where it is missing (Linux
// Wayland, some browsers), the system language decides.

import { layoutForLocale, type KeyboardLayout } from '@shared/spelling/keyboard';

export async function detectKeyboardLayout(): Promise<KeyboardLayout> {
  try {
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?(): Promise<Map<string, string>> } }).keyboard;
    const map = await kb?.getLayoutMap?.();
    if (map) {
      if (map.get('KeyY') === 'z' && map.get('KeyZ') === 'y') return 'qwertz';
      if (map.get('KeyQ') === 'a' && map.get('KeyA') === 'q') return 'azerty';
      if (map.get('KeyY') === 'y' && map.get('KeyQ') === 'q') return 'qwerty';
    }
  } catch {
    /* not allowed here, e.g. in a background frame */
  }
  return layoutForLocale(navigator.language);
}
