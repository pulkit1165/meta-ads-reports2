import type { Config } from 'tailwindcss';

/**
 * Colours resolve to CSS variables defined in globals.css, so switching theme
 * is a palette swap on <html data-theme> rather than a second set of classes.
 * Nothing in the app should hard-code a hex value.
 */
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--ink)',
        panel: 'var(--panel)',
        edge: 'var(--edge)',
        muted: 'var(--muted)',
        gold: 'var(--gold)',
        'gold-deep': 'var(--gold-deep)',
        good: 'var(--good)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
        text: 'var(--text)',
        'text-strong': 'var(--text-strong)',
      },
      backgroundColor: { hover: 'var(--hover)', tint: 'var(--tint)' },
      fontFamily: { display: ['Georgia', 'serif'] },
      boxShadow: { card: 'var(--shadow)' },
    },
  },
  plugins: [],
} satisfies Config;
