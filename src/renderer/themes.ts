// Colour themes. Each theme sets the same tokens; soft tints for underlines and
// highlights are derived in CSS with color-mix, so a theme only names base colours.

export interface ThemeColors {
  bg: string; // window background
  surface: string; // panels, cards, inputs
  sunk: string; // recessed areas, code
  ink: string; // body text
  ink2: string; // secondary text
  ink3: string; // muted text
  line: string; // hairlines
  lineStrong: string; // borders of controls
  accent: string; // the one emphasis colour
  accentInk: string; // accent used as text
  onAccent: string; // text on accent-filled buttons
  spelling: string;
  grammar: string;
  style: string;
  rules: string;
  good: string;
  bad: string;
}

export interface Theme {
  label: string;
  dark: boolean;
  colors: ThemeColors;
}

export const THEMES: Record<string, Theme> = {
  light: {
    label: 'Light',
    dark: false,
    colors: {
      bg: '#fafafa', surface: '#ffffff', sunk: '#f2f3f3', ink: '#23373b', ink2: '#4d5b5e', ink3: '#7b8789',
      line: '#e1e4e4', lineStrong: '#cfd3d4', accent: '#eb811b', accentInk: '#9a4d05', onAccent: '#ffffff',
      spelling: '#ee6677', grammar: '#4477aa', style: '#228833', rules: '#aa3377', good: '#228833', bad: '#ee6677',
    },
  },
  dark: {
    label: 'Dark',
    dark: true,
    colors: {
      bg: '#15191b', surface: '#1b2023', sunk: '#111517', ink: '#e6ebec', ink2: '#b4bfc1', ink3: '#85918f',
      line: '#2a3134', lineStrong: '#3a4246', accent: '#f0943d', accentInk: '#f6b679', onAccent: '#15191b',
      spelling: '#f08896', grammar: '#7aa3cc', style: '#5bb36a', rules: '#cf7aa8', good: '#5bb36a', bad: '#f08896',
    },
  },
  'gruvbox-light-soft': {
    label: 'Gruvbox light soft',
    dark: false,
    colors: {
      bg: '#f2e5bc', surface: '#f2e5bc', sunk: '#ebdbb2', ink: '#3c3836', ink2: '#504945', ink3: '#7c6f64',
      line: '#d5c4a1', lineStrong: '#bdae93', accent: '#af3a03', accentInk: '#af3a03', onAccent: '#f2e5bc',
      spelling: '#9d0006', grammar: '#076678', style: '#79740e', rules: '#8f3f71', good: '#79740e', bad: '#9d0006',
    },
  },
  'gruvbox-light': {
    label: 'Gruvbox light',
    dark: false,
    colors: {
      bg: '#fbf1c7', surface: '#fbf1c7', sunk: '#ebdbb2', ink: '#3c3836', ink2: '#504945', ink3: '#7c6f64',
      line: '#ebdbb2', lineStrong: '#d5c4a1', accent: '#af3a03', accentInk: '#af3a03', onAccent: '#fbf1c7',
      spelling: '#9d0006', grammar: '#076678', style: '#79740e', rules: '#8f3f71', good: '#79740e', bad: '#9d0006',
    },
  },
  'gruvbox-dark-soft': {
    label: 'Gruvbox dark soft',
    dark: true,
    colors: {
      bg: '#32302f', surface: '#32302f', sunk: '#282828', ink: '#ebdbb2', ink2: '#d5c4a1', ink3: '#a89984',
      line: '#3c3836', lineStrong: '#504945', accent: '#fe8019', accentInk: '#fe8019', onAccent: '#32302f',
      spelling: '#fb4934', grammar: '#83a598', style: '#b8bb26', rules: '#d3869b', good: '#b8bb26', bad: '#fb4934',
    },
  },
  'gruvbox-dark': {
    label: 'Gruvbox dark',
    dark: true,
    colors: {
      bg: '#282828', surface: '#282828', sunk: '#1d2021', ink: '#ebdbb2', ink2: '#d5c4a1', ink3: '#a89984',
      line: '#3c3836', lineStrong: '#504945', accent: '#fe8019', accentInk: '#fe8019', onAccent: '#282828',
      spelling: '#fb4934', grammar: '#83a598', style: '#b8bb26', rules: '#d3869b', good: '#b8bb26', bad: '#fb4934',
    },
  },
  'solarized-light': {
    label: 'Solarized light',
    dark: false,
    colors: {
      bg: '#eee8d5', surface: '#fdf6e3', sunk: '#eee8d5', ink: '#073642', ink2: '#586e75', ink3: '#93a1a1',
      line: '#eee8d5', lineStrong: '#d9d2bc', accent: '#cb4b16', accentInk: '#cb4b16', onAccent: '#fdf6e3',
      spelling: '#dc322f', grammar: '#268bd2', style: '#859900', rules: '#d33682', good: '#859900', bad: '#dc322f',
    },
  },
  'solarized-dark': {
    label: 'Solarized dark',
    dark: true,
    colors: {
      bg: '#00212b', surface: '#002b36', sunk: '#00212b', ink: '#eee8d5', ink2: '#93a1a1', ink3: '#839496',
      line: '#073642', lineStrong: '#0e4a59', accent: '#cb4b16', accentInk: '#e3743f', onAccent: '#fdf6e3',
      spelling: '#dc322f', grammar: '#268bd2', style: '#859900', rules: '#d33682', good: '#859900', bad: '#dc322f',
    },
  },
  nord: {
    label: 'Nord',
    dark: true,
    colors: {
      bg: '#2e3440', surface: '#3b4252', sunk: '#2e3440', ink: '#eceff4', ink2: '#d8dee9', ink3: '#9aa5b8',
      line: '#434c5e', lineStrong: '#4c566a', accent: '#d08770', accentInk: '#d08770', onAccent: '#2e3440',
      spelling: '#bf616a', grammar: '#81a1c1', style: '#a3be8c', rules: '#b48ead', good: '#a3be8c', bad: '#bf616a',
    },
  },
  'catppuccin-latte': {
    label: 'Catppuccin Latte',
    dark: false,
    colors: {
      bg: '#e6e9ef', surface: '#eff1f5', sunk: '#dce0e8', ink: '#4c4f69', ink2: '#5c5f77', ink3: '#8c8fa1',
      line: '#ccd0da', lineStrong: '#bcc0cc', accent: '#fe640b', accentInk: '#d4520a', onAccent: '#eff1f5',
      spelling: '#d20f39', grammar: '#1e66f5', style: '#40a02b', rules: '#8839ef', good: '#40a02b', bad: '#d20f39',
    },
  },
  'catppuccin-mocha': {
    label: 'Catppuccin Mocha',
    dark: true,
    colors: {
      bg: '#181825', surface: '#1e1e2e', sunk: '#11111b', ink: '#cdd6f4', ink2: '#bac2de', ink3: '#7f849c',
      line: '#313244', lineStrong: '#45475a', accent: '#fab387', accentInk: '#fab387', onAccent: '#1e1e2e',
      spelling: '#f38ba8', grammar: '#89b4fa', style: '#a6e3a1', rules: '#cba6f7', good: '#a6e3a1', bad: '#f38ba8',
    },
  },
};

export const THEME_OPTIONS: [string, string][] = [['system', 'System (light or dark)'], ...Object.entries(THEMES).map(([id, t]) => [id, t.label] as [string, string])];

const TOKENS: [keyof ThemeColors, string][] = [
  ['bg', '--bg'], ['surface', '--surface'], ['sunk', '--sunk'], ['ink', '--ink'], ['ink2', '--ink-2'], ['ink3', '--ink-3'],
  ['line', '--line'], ['lineStrong', '--line-strong'], ['accent', '--accent'], ['accentInk', '--accent-ink'], ['onAccent', '--on-accent'],
  ['spelling', '--spelling'], ['grammar', '--grammar'], ['style', '--style'], ['rules', '--rules'], ['good', '--good'], ['bad', '--bad'],
];

let media: MediaQueryList | null = null;
let listener: (() => void) | null = null;

export function resolveTheme(id: string): Theme {
  if (id !== 'system' && THEMES[id]) return THEMES[id]!;
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return dark ? THEMES.dark! : THEMES.light!;
}

/** Apply a theme to the document; "system" follows the OS setting live. */
export function applyTheme(id: string) {
  const root = document.documentElement;
  const set = () => {
    const t = resolveTheme(id);
    for (const [k, v] of TOKENS) root.style.setProperty(v, t.colors[k]);
    root.style.colorScheme = t.dark ? 'dark' : 'light';
    root.dataset.theme = id;
    root.dataset.dark = String(t.dark);
  };
  if (media && listener) media.removeEventListener('change', listener);
  media = null;
  listener = null;
  if (id === 'system' && window.matchMedia) {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    listener = set;
    media.addEventListener('change', listener);
  }
  set();
}
