import type { Config } from 'tailwindcss'

// Every colour resolves through a CSS variable so a theme swap is one
// data-theme attribute on <html>. See app/globals.css for the palettes.
const themed = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: themed('bg'),
        surface: themed('surface'),
        raised: themed('raised'),
        border: themed('border'),
        text: themed('text'),
        muted: themed('muted'),
        accent: themed('accent'),
        'accent-fg': themed('accent-fg'),
        success: themed('success'),
        warn: themed('warn'),
        danger: themed('danger'),
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        // Tight. Large radii are most of what makes a UI read as generic.
        card: '4px',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.25s ease-out both',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
}

export default config
