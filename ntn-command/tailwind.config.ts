import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0d0f12',
        panel: '#14181d',
        edge: '#232a32',
        muted: '#8b97a5',
        gold: '#c79353',
        good: '#22c55e',
        warn: '#f59e0b',
        bad: '#ef4444',
      },
      fontFamily: { display: ['Georgia', 'serif'] },
    },
  },
  plugins: [],
} satisfies Config;
