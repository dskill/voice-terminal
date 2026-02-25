/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/app/**/*.{js,jsx}', './src/app/index.html'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"SF Mono"', 'Monaco', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-recording': 'pulse-recording 1.5s ease-in-out infinite',
        'glow': 'glow 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-recording': {
          '0%, 100%': { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(239, 68, 68, 0.4)' },
          '50%': { transform: 'scale(1.05)', boxShadow: '0 0 20px 10px rgba(239, 68, 68, 0.2)' },
        },
        'glow': {
          '0%, 100%': { boxShadow: '0 0 15px rgba(59, 130, 246, 0.4)' },
          '50%': { boxShadow: '0 0 30px rgba(59, 130, 246, 0.6)' },
        },
      },
    },
  },
  plugins: [],
};
