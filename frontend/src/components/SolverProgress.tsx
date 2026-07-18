import type { SolverStatus } from '../types'

interface Props {
  status: SolverStatus
  elapsed: number
  timeLimit: number
}

const STATUS_META: Record<SolverStatus, { label: string; color: string; bg: string }> = {
  idle:       { label: '대기 중',              color: '#64748b', bg: '#f1f5f9' },
  pending:    { label: '준비 중...',            color: '#2563eb', bg: '#eff6ff' },
  running:    { label: '솔버 실행 중',          color: '#7c3aed', bg: '#f5f3ff' },
  done:       { label: '✅ 완료',              color: '#065f46', bg: '#d1fae5' },
  infeasible: { label: '❌ 해 없음',           color: '#991b1b', bg: '#fee2e2' },
  error:      { label: '❌ 오류 발생',         color: '#991b1b', bg: '#fee2e2' },
}

export default function SolverProgress({ status, elapsed, timeLimit }: Props) {
  const meta    = STATUS_META[status]
  const running = status === 'running' || status === 'pending'
  // 백엔드는 feasibility(최대 15초) + 최적화(timeLimit) 순서로 동작
  const total   = timeLimit + 18
  const pct     = running ? Math.min((elapsed / total) * 100, 97) : status === 'done' ? 100 : 0
  const phase   = !running ? '' : elapsed < 3 ? '제약 구성 중...' : elapsed < 18 ? '기본 해 탐색 중...' : '희망·형평성 최적화 중...'

  return (
    <div style={{
      background: meta.bg,
      border: `0.5px solid ${meta.color}44`,
      borderRadius: 10,
      padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: running ? 8 : 0 }}>
        {running && (
          <span style={{
            display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
            border: `2px solid ${meta.color}44`,
            borderTopColor: meta.color,
            animation: 'spin 0.8s linear infinite',
            flexShrink: 0,
          }} />
        )}
        <span style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>{meta.label}</span>
        {running && elapsed > 0 && (
          <span style={{ fontSize: 12, color: meta.color, marginLeft: 'auto' }}>
            {elapsed}s
          </span>
        )}
        {status === 'done' && elapsed > 0 && (
          <span style={{ fontSize: 12, color: meta.color, marginLeft: 'auto' }}>
            {elapsed}초 소요
          </span>
        )}
      </div>

      {running && phase && (
        <div style={{ fontSize: 11, color: meta.color, opacity: 0.85, marginBottom: 6 }}>
          {phase}
        </div>
      )}

      {(running || status === 'done') && (
        <div style={{ height: 4, background: `${meta.color}22`, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: meta.color,
            borderRadius: 2,
            transition: running ? 'width 0.5s ease' : 'none',
          }} />
        </div>
      )}

      {status === 'infeasible' && (
        <div style={{ fontSize: 12, color: '#991b1b', marginTop: 6, lineHeight: 1.5 }}>
          제약 조건이 너무 강하거나 간호사 수가 부족합니다.<br/>
          최소 인원을 낮추거나 간호사를 추가해보세요.
        </div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 12, color: '#991b1b', marginTop: 6, lineHeight: 1.5 }}>
          백엔드 서버가 실행 중인지 확인해주세요.
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
