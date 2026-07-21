import type { ConstraintConfig } from '../types'
import { color, radius } from '../theme'

interface Props {
  config: ConstraintConfig
  onChange: (c: ConstraintConfig) => void
}

const label: React.CSSProperties = {
  fontSize: 12,
  color: color.textSecondary,
  marginBottom: 3,
  display: 'block',
}
const numInput: React.CSSProperties = {
  width: '100%',
  padding: '7px 8px',
  borderRadius: radius.sm,
  border: `1px solid ${color.border}`,
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'center',
  background: color.bgMuted,
  color: color.text,
}
const sectionTitle: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 800,
  color: color.text,
  marginBottom: 10,
  paddingBottom: 8,
  borderBottom: `1px solid ${color.border}`,
}
const row: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
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

      {/* 최소 인원 */}
      <div>
        <div style={sectionTitle}>👥 일별 최소 인원</div>
        <div style={{ fontSize: 11, color: color.textTertiary, marginBottom: 8, lineHeight: 1.5 }}>
          생성된 표는 이 인원을 보장합니다 (불가능한 경우에만 자동 완화).<br/>
          기간(년/월)은 상단 헤더에서 변경하세요.
        </div>
        {DAY_TYPES.map(({ key, label: lbl }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6,
              color: key === 'sunday' ? color.dangerStrong : key === 'saturday' ? color.purpleStrong : color.text }}>
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
            { key: 'max_consecutive_work', label: '최대 연속 근무일' },
            { key: 'min_night_block',      label: '나이트 최소 연속' },
            { key: 'max_night_block',      label: '나이트 최대 연속' },
            { key: 'night_dedicated_count',label: 'N 전담 고정 수' },
            { key: 'max_first_year',       label: '1년차 최대 인원' },
          ] as { key: keyof ConstraintConfig; label: string }[]).map(({ key, label: lbl }) => (
            <div key={key} style={row}>
              <span style={{ fontSize: 13 }}>{lbl}</span>
              <input type="number" min={1} max={99} style={{ ...numInput, width: 64 }}
                value={config[key] as number}
                onChange={e => set(key, +e.target.value)} />
            </div>
          ))}
        </div>
      </div>

      {/* 나이트 soft 파라미터 */}
      <div>
        <div style={sectionTitle}>🌙 나이트 세부 설정</div>
        <div style={{ fontSize: 11, color: color.textTertiary, marginBottom: 8, lineHeight: 1.5 }}>
          권장 최대 수 초과 및 블록 간격 부족 시 소프트 패널티가 부과됩니다.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {([
            { key: 'night_max_count', label: 'N 권장 최대 수' },
            { key: 'night_min_gap',   label: '블록 간 최소 간격 (일)' },
          ] as { key: keyof ConstraintConfig; label: string }[]).map(({ key, label: lbl }) => (
            <div key={key} style={row}>
              <span style={{ fontSize: 13 }}>{lbl}</span>
              <input type="number" min={1} max={99} style={{ ...numInput, width: 64 }}
                value={config[key] as number}
                onChange={e => set(key, +e.target.value)} />
            </div>
          ))}
        </div>
      </div>

      {/* 2교대 (6D/6N) */}
      <div>
        <div style={sectionTitle}>🔄 2교대 (6D/6N)</div>
        <div style={{ fontSize: 11, color: color.textTertiary, marginBottom: 8, lineHeight: 1.5 }}>
          6D(12h 낮) · 6N(12h 야)은 반드시 쌍으로 배정됩니다.<br/>
          간호사 명단에서 "2교대 가능" 체크 필요.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {([
            { key: 'max_two_shift_pairs_per_day', label: '일 최대 2교대 쌍 수' },
            { key: 'max_d6_block',                label: '6D 최대 연속' },
            { key: 'max_n6_block',                label: '6N 최대 연속' },
          ] as { key: keyof ConstraintConfig; label: string }[]).map(({ key, label: lbl }) => (
            <div key={key} style={row}>
              <span style={{ fontSize: 13 }}>{lbl}</span>
              <input type="number" min={0} max={10} style={{ ...numInput, width: 64 }}
                value={config[key] as number}
                onChange={e => set(key, +e.target.value)} />
            </div>
          ))}
        </div>
      </div>

      {/* 솔버 옵션 */}
      <div>
        <div style={sectionTitle}>⚙️ 솔버 옵션</div>
        <div style={row}>
          <span style={{ fontSize: 13 }}>제한 시간 (초)</span>
          <input type="number" min={10} max={600} style={{ ...numInput, width: 72 }}
            value={config.time_limit_seconds}
            onChange={e => set('time_limit_seconds', +e.target.value)} />
        </div>
        <div style={{ fontSize: 11, color: color.textTertiary, marginTop: 6, lineHeight: 1.5 }}>
          간호사 수·제약이 많을수록 시간이 더 필요합니다.<br/>
          복잡한 경우 120초 이상 권장.
        </div>
      </div>
    </div>
  )
}
