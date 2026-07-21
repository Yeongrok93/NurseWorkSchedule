/**
 * 디자인 토큰 — 뉴트럴 그레이 + 단일 액센트 블루 (토스 톤 참조)
 * 컴포넌트마다 색을 즉흥적으로 박지 않고 여기서만 정의한다.
 */

export const color = {
  bg: '#ffffff',
  bgSubtle: '#f2f4f6',
  bgMuted: '#f9fafb',
  border: '#e5e8eb',
  borderStrong: '#d1d6db',

  text: '#191f28',
  textSecondary: '#6b7684',
  textTertiary: '#8b95a1',

  accent: '#3182f6',
  accentStrong: '#1b64da',
  accentBg: '#eaf2ff',

  success: '#00a876',
  successStrong: '#00875a',
  successBg: '#e7f9f3',

  danger: '#f04452',
  dangerStrong: '#d92d3d',
  dangerBg: '#feecee',

  warning: '#e8990c',
  warningStrong: '#c2740a',
  warningBg: '#fff4e5',

  purple: '#7c5cfc',
  purpleStrong: '#6938d3',
  purpleBg: '#f3efff',

  dark: '#191f28',       // 그리드 헤더 등 진한 배경
  darkSubtle: '#2c333d',
} as const

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const

export const shadow = {
  card: '0 1px 2px rgba(15,23,42,0.04), 0 4px 14px rgba(15,23,42,0.05)',
  pop: '0 12px 32px rgba(15,23,42,0.16)',
} as const

/** 카드 컨테이너 공통 스타일 */
export function card(extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: color.bg,
    border: `1px solid ${color.border}`,
    borderRadius: radius.lg,
    boxShadow: shadow.card,
    ...extra,
  }
}

/** 뱃지/칩 공통 스타일 */
export function chip(bg: string, fg: string, extra?: React.CSSProperties): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 9px',
    borderRadius: radius.pill,
    fontSize: 11,
    fontWeight: 700,
    background: bg,
    color: fg,
    lineHeight: 1.6,
    ...extra,
  }
}

/** 버튼 공통 스타일 (variant: primary | secondary | ghost | danger) */
export function button(
  variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'primary',
  extra?: React.CSSProperties,
): React.CSSProperties {
  const base: React.CSSProperties = {
    border: 'none',
    borderRadius: radius.md,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }
  const variants: Record<string, React.CSSProperties> = {
    primary:   { background: color.accent, color: '#fff' },
    secondary: { background: color.bgSubtle, color: color.text },
    ghost:     { background: 'transparent', color: color.textSecondary, border: `1px solid ${color.border}` },
    danger:    { background: color.danger, color: '#fff' },
  }
  return { ...base, ...variants[variant], ...extra }
}
