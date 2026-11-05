// "Always on" switch for rule sets and taste profiles: an always-on set is
// checked in every document of its language without being picked in the
// editor. The switch is a setting, saved at once, not part of the draft.

import { useApp } from './state';

export function AlwaysOnSwitch({ kind, id }: { kind: 'rules' | 'profiles'; id: string }) {
  const app = useApp();
  const on = app.isAlwaysOn(kind, id);
  const what = kind === 'rules' ? 'rule set' : 'profile';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch${on ? ' on' : ''}`}
      onClick={() => void app.setAlwaysOn(kind, id, !on)}
      title={
        on
          ? `Always on: this ${what} is checked in every document in its language. Click to pick it per project instead.`
          : `Check this ${what} in every document in its language, without picking it in the editor.`
      }
    >
      <span className="knob" aria-hidden />
      Always on
    </button>
  );
}
