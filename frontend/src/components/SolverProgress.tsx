import type { SolverStatus } from '../types'
import { color, radius } from '../theme'

interface Props {
  status: SolverStatus
  elapsed: number
  timeLimit: number
}

const STATUS_META: Record<SolverStatus, { label: string; tone: string; bg: string }> = {
  idle:       { label: '대기 중',       tone: color.textSecondary, bg: color.bgMuted },
  pending:    { label: '준비 중',       tone: color.accent,        bg: color.accentBg },
  running:    { label: '실행 중',       tone: color.accent,        bg: color.accentBg },
  done:       { label: '완료',          tone: color.successStrong, bg: color.successBg },
  infeasible: { label: '해 없음',       tone: color.dangerStrong,  bg: color.dangerBg },
  error:      { label: '오류 발생',     tone: color.dangerStrong,  bg: color.dangerBg },
}

// GitHub Actions 스타일 단계별 진행 — 백엔드 solve() 의 실제 3단계와 대응
const STEPS = [
  { key: 'build',  label: '제약 구성',        until: 3 },
  { key: 'feas',   label: '기본 해 탐색',      until: 18 },
  { key: 'optim',  label: '희망·형평성 최적화', until: Infinity },
] as const

function StepIcon({ state }: { state: 'done' | 'active' | 'pending' | 'error' }) {
  if (state === 'done') {
    return (
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: color.success,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
          <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: color.danger,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#fff',
        fontSize: 11, fontWeight: 800,
      }}>×</div>
    )
  }
  if (state === 'active') {
    return (
      <div style={{
        width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${color.accentBg}`, borderTopColor: color.accent,
        animation: 'spin 0.8s linear infinite',
      }} />
    )
  }
  return (
    <div style={{
      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
      border: `2px solid ${color.border}`, background: color.bg,
    }} />
  )
}

export default function SolverProgress({ status, elapsed, timeLimit }: Props) {
  const meta    = STATUS_META[status]
  const running = status === 'running' || status === 'pending'
  const failed  = status === 'infeasible' || status === 'error'

  function stepState(idx: number): 'done' | 'active' | 'pending' | 'error' {
    if (status === 'done') return 'done'
    if (failed) return idx === 0 ? 'error' : 'pending'
    if (!running) return 'pending'
    const lower = idx === 0 ? 0 : STEPS[idx - 1].until
    if (elapsed >= STEPS[idx].until) return 'done'
    if (elapsed >= lower) return 'active'
    return 'pending'
  }

  return (
    <div style={{
      background: color.bgMuted,
      border: `1px solid ${color.border}`,
      borderRadius: radius.lg,
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: (running || failed) ? 12 : 0 }}>
        <span style={{
          fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: radius.pill,
          background: meta.bg, color: meta.tone,
        }}>
          {meta.label}
        </span>
        {running && elapsed > 0 && (
          <span style={{ fontSize: 12, color: color.textTertiary, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
            {elapsed}s
          </span>
        )}
        {status === 'done' && elapsed > 0 && (
          <span style={{ fontSize: 12, color: color.textTertiary, marginLeft: 'auto' }}>
            {elapsed}초 소요
          </span>
        )}
      </div>

      {(running || status === 'done') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {STEPS.map((s, i) => {
            const st = stepState(i)
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <StepIcon state={st} />
                <span style={{
                  fontSize: 12.5,
                  fontWeight: st === 'active' ? 700 : 500,
                  color: st === 'pending' ? color.textTertiary : color.text,
                }}>
                  {s.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {status === 'infeasible' && (
        <div style={{ fontSize: 12, color: color.dangerStrong, lineHeight: 1.6 }}>
          제약 조건이 너무 강하거나 간호사 수가 부족합니다.<br/>
          최소 인원을 낮추거나 간호사를 추가해보세요.
        </div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 12, color: color.dangerStrong, lineHeight: 1.6 }}>
          백엔드 서버가 실행 중인지 확인해주세요.
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
