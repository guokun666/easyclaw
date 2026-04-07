const variants = {
  primary: [
    'border border-[#0b82ef] text-white',
    'bg-[linear-gradient(180deg,#2f9fff_0%,#0071e3_100%)]',
    'shadow-[0_18px_34px_rgba(0,113,227,0.24),inset_0_1px_0_rgba(255,255,255,0.32)]',
    'hover:-translate-y-px hover:brightness-[1.03] hover:shadow-[0_22px_38px_rgba(0,113,227,0.28),inset_0_1px_0_rgba(255,255,255,0.42)]',
    'active:translate-y-0 active:scale-[0.985]'
  ].join(' '),
  secondary: [
    'border border-black/6 bg-white/78 text-text',
    'shadow-[0_14px_28px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.8)]',
    'hover:-translate-y-px hover:bg-white/92 hover:border-black/10',
    'active:translate-y-0 active:scale-[0.985]'
  ].join(' ')
} as const

const sizes = {
  lg: 'px-8 py-3.5 text-[15px] gap-2.5 rounded-full',
  sm: 'px-5 py-2.5 text-[13px] gap-1.5 rounded-full'
} as const

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
  loading?: boolean
}

export default function Button({
  variant = 'primary',
  size = 'sm',
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={`inline-flex items-center justify-center font-semibold tracking-[0.01em] transition-all duration-200 cursor-pointer backdrop-blur-xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:brightness-100 ${variants[variant]} ${sizes[size]} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path
            d="M12 2a10 10 0 0 1 10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )}
      {children}
    </button>
  )
}
