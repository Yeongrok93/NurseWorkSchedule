import type { ConstraintConfig } from '../types'

interface Props {
  config: ConstraintConfig
  onChange: (c: ConstraintConfig) => void
}

const label: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  marginBottom: 3,
  display: 'block',
}
const numInput: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 6,
  border: '0.5px solid var(--color-border-secondary)',
  fontSize: 13,
  textAlign: 'center',
  background: 'var(--color-background-primary)',
  color: 'var(--color-text-primary)',
}
const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  letterSpacing: '0.5px',
  textTransform: 'uppercase' as const,
  marginBottom: 10,
  paddingBottom: 6,
  borderBottom: '0.5px solid var(--color-border-tertiary)',
}

const DAY_TYPES = [
  { key: 'weekday',  label: '평일' },
  { key: 'saturday', label: '토요일' },
  { key: 'sunday',   label: '일요일·공휴일' },
] as const

export default function ConstraintPanel({ config, onChange }: Props) {
  function setStaff(type: 'weekday'|'saturday'|'sunday', shift: string, val: number) {
    onChange({ ...config, [`min_staff_${type}`]: { ...(config[`min_staff_${type}`] as any), [shift]: val } })
  }
  function set(key: keyof ConstraintConfig, val: number) {
    onChange({ ...config, [key]: val })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* 기간 */}
      <div>
        <div style={sectionTitle}>📅 기간</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <span style={label}>년도</span>
            <input type="number" style={numInput} value={config.year}
              onChange={e => onChange({ ...config, year: +e.target.value })} />
          </div>
          <div>
            <span style={label}>월</span>
            <select style={{ ...numInput, textAlign: 'left' }} value={config.month}
              onChange={e => onChange({ ...config, month: +e.target.value })}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i+1} value={i+1}>{i+1}월</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 최소 인원 */}
      <div>
        <div style={sectionTitle}>👥 일별 최소 인원</div>
        {DAY_TYPES.map(({ key, label: lbl }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6,
              color: key === 'sunday' ? '#dc2626' : key === 'saturday' ? '#7c3aed' : 'var(--color-text-primary)' }}>
              {lbl}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              {(['D','E','N'] as const).map(sh => (
                <div key={sh}>
                  <span style={{ ...label, textAlign: 'center' as const }}>{sh}</span>
                  <input type="number" min={1} max={20} style={numInput}
                    value={(config[`min_staff_${key}`] as any)[sh] ?? 0}
                    onChange={e => setStaff(key, sh, +e.target.value)} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 근무 패턴 */}
      <div>
        <div style={sectionTitle}>🔒 근무 패턴</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {([
            { key: 'max_consecutive_work',   label: '최대 연속 근무일' },
            { key: 'min_night_block',         label: '나이트 최소 연속' },
            { key: 'max_night_block',         label: '나이트 최대 연속' },
            { key: 'night_dedicated_count',   label: 'N 전담 고정 수' },
            { key: 'max_first_year',          label: '1년차 최대 인원' },
          ] as { key: keyof ConstraintConfig; label: string }[]).map(({ key, label: lbl }) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>{lbl}</span>
              <input type="number" min={1} max={99} style={{ ...numInput, width: 64 }}
                value={config[key] as number}
                onChange={e => set(key, +e.target.value)} />
            </div>
          ))}
        </div>
      </div>

      {/* 솔버 옵션 */}
      <div>
        <div style={sectionTitle}>⚙️ 솔버 옵션</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13 }}>제한 시간 (초)</span>
          <input type="number" min={10} max={600} style={{ ...numInput, width: 72 }}
            value={config.time_limit_seconds}
            onChange={e => set('time_limit_seconds', +e.target.value)} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
          간호사 수·제약이 많을수록 시간이 더 필요합니다.<br/>
          복잡한 경우 120초 이상 권장.
        </div>
      </div>
    </div>
  )
}
