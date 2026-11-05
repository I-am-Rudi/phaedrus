// Keep a toolbar on one line. When its content is wider than the space, step
// through compaction levels (data-compact="1".."max", styled in styles.css)
// until it fits; if even the last level overflows, mark it "clipped" so the
// end shows an ellipsis instead of the controls running off or wrapping.

import { useLayoutEffect } from 'react';

export function useFit(el: HTMLElement | null, max: number) {
  useLayoutEffect(() => {
    if (!el) return;
    let running = false;
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    const fit = () => {
      if (running) return;
      running = true;
      el.classList.remove('clipped');
      let level = 0;
      el.dataset.compact = '0';
      while (!fits() && level < max) el.dataset.compact = String(++level);
      if (!fits()) el.classList.add('clipped');
      running = false;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    // Text changes (status, file name, profile names) can change the width too.
    const mo = new MutationObserver(fit);
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [el, max]);
}
