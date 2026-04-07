import { type CSSProperties } from 'react'

type LogoState = 'idle' | 'loading' | 'success' | 'error'

const stateStyles: Record<LogoState, CSSProperties> = {
  idle: {},
  loading: { animation: 'logo-bounce 0.8s ease-in-out infinite' },
  success: { filter: 'drop-shadow(0 0 16px rgba(52, 211, 153, 0.45))' },
  error: {
    filter: 'drop-shadow(0 0 16px rgba(251, 113, 133, 0.45))',
    animation: 'logo-shake 0.5s ease-in-out'
  }
}

export default function BrandLogo({
  state = 'idle',
  size = 120
}: {
  state?: LogoState
  size?: number
}): React.JSX.Element {
  const palette = {
    idle: { a: '#fb923c', b: '#ea580c', ring: '#f97316', text: '#fff7ed' },
    loading: { a: '#fb923c', b: '#ea580c', ring: '#f97316', text: '#fff7ed' },
    success: { a: '#34d399', b: '#059669', ring: '#10b981', text: '#ecfdf5' },
    error: { a: '#fb7185', b: '#e11d48', ring: '#f43f5e', text: '#fff1f2' }
  }[state]

  return (
    <>
      <style>{`
        @keyframes logo-bounce {
          0%, 100% { transform: translateY(0); }
          30% { transform: translateY(-6px); }
          70% { transform: translateY(-6px); }
        }
        @keyframes logo-shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-3px); }
          40% { transform: translateX(3px); }
          60% { transform: translateX(-2px); }
          80% { transform: translateX(2px); }
        }
      `}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ transition: 'filter 0.4s, transform 0.4s', ...stateStyles[state] }}
      >
        <defs>
          <linearGradient id="brandGrad" x1="16" y1="16" x2="104" y2="104" gradientUnits="userSpaceOnUse">
            <stop stopColor={palette.a} />
            <stop offset="1" stopColor={palette.b} />
          </linearGradient>
          <radialGradient id="brandGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(60 48) rotate(90) scale(52)">
            <stop stopColor={palette.ring} stopOpacity="0.28" />
            <stop offset="1" stopColor={palette.ring} stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx="60" cy="60" r="50" fill="url(#brandGlow)" />
        <rect x="18" y="18" width="84" height="84" rx="24" fill="url(#brandGrad)" />
        <rect x="26" y="26" width="68" height="68" rx="18" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />

        <path
          d="M71 38C64 34 55 34 48.5 38C40 43 35 52 35 60C35 68 40 77 48.5 82C55 86 64 86 71 82"
          stroke={palette.text}
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M72 48L84 60L72 72"
          stroke={palette.text}
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  )
}
