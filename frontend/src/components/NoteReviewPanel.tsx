import { useState } from 'react'
import type { NoteInterpretation, NoteInterpretResult } from '../types'

interface Props {
  result: NoteInterpretResult
  month: number
  onApply: (items: NoteInterpretation[]) => void
  onCancel: () => void
  applying: boolean
}

const RANK_STYLE: Record<number, { bg: string; fg: string; label: string }> = {
  1: { bg: '#fee2e2', fg: '#991b1b', label: '1순위' },
  2: { bg: '#ffedd5', fg: '#9a3412', label: '2순위' },
  3: { bg: '#fef3c7', fg: '#854d0e', label: '3순위' },
}

/** 연속된 날짜를 "5~8" 형태로 압축 */
function compactDays(days: number[]): string {
  if (!days.length) return ''
  const s = [...days].sort((a, b) => a - b)
  const parts: string[] = []
  let start = s[0], prev = s[0]
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === prev + 1) { prev = s[i]; continue }
    parts.push(start === prev ? `${start}` : `${start}~${prev}`)
    if (i < s.length) { start = s[i]; prev = s[i] }
  }
  return parts.join(', ')
}

export default function NoteReviewPanel({ result, month, onApply, onCancel, applying }: Props) {
  // 항목별 반영 여부 (기본 전부 체크)
  const [enabled, setEnabled] = useState<Record<number, boolean>>(
    () => Object.fromEntries(result.items.map(i => [i.index, true]))
  )

  const usable = result.items.filter(
    i => i.priority_requests.length > 0 || i.weekly_fixed_off.length > 0
  )
  const selected = usable.filter(i => enabled[i.index])
  const reviewOnly = result.items.filter(
    i => i.priority_requests.length === 0 && i.weekly_fixed_off.length === 0 && i.leftover
  )

  return (
    <div style={{
      marginBottom: 16, borderRadius: 12, overflow: 'hidden',
      border: '1px solid #c7d2fe', background: 'var(--color-background-primary)',
    }}>
      {/* 헤더 */}
      <div style={{
        padding: '12px 16px', background: '#eef2ff',
        borderBottom: '1px solid #c7d2fe',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#3730a3' }}>
          📝 특기사항 해석 결과 — 확인 후 반영
        </span>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
          background: result.engine === 'llm' ? '#ddd6fe' : '#e2e8f0',
          color: result.engine === 'llm' ? '#5b21b6' : '#475569',
        }}>
          {result.engine === 'llm' ? 'AI 해석' : '규칙 기반 해석'}
        </span>
        <span style={{ fontSize: 12, color: '#4338ca' }}>
          {usable.length}건 적용 가능 · {selected.length}건 선택됨
        </span>
        <button onClick={onCancel} style={{
          marginLeft: 'auto', background: 'none', border: 'none',
          cursor: 'pointer', fontSize: 18, color: '#6366f1', lineHeight: 1,
        }}>×</button>
      </div>

      {result.warning && (
        <div style={{
          padding: '8px 16px', fontSize: 12, background: '#fef3c7', color: '#92400e',
          borderBottom: '1px solid #fde68a',
        }}>
          ⚠ {result.warning}
        </div>
      )}

      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
        아래는 특기사항 문장을 <b>제안</b>으로 바꾼 것입니다. 최소인원·연속근무 같은 근무 규칙은 바뀌지 않습니다.
        틀린 항목은 체크를 해제하세요.
      </div>

      {/* 해석 목록 */}
      <div style={{ maxHeight: 340, overflowY: 'auto', padding: '0 16px 12px' }}>
        {usable.map(it => (
          <label key={it.index} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '9px 10px', marginBottom: 6, borderRadius: 8, cursor: 'pointer',
            background: enabled[it.index] ? 'var(--color-background-secondary)' : 'transparent',
            border: `1px solid ${enabled[it.index] ? 'var(--color-border-secondary)' : 'var(--color-border-tertiary)'}`,
            opacity: enabled[it.index] ? 1 : 0.55,
          }}>
            <input type="checkbox" checked={!!enabled[it.index]} style={{ marginTop: 3 }}
              onChange={e => setEnabled({ ...enabled, [it.index]: e.target.checked })} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{it.name}</span>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  “{it.note}”
                </span>
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                {it.priority_requests.map((p, i) => {
                  const st = RANK_STYLE[p.rank] ?? RANK_STYLE[3]
                  return (
                    <span key={i} style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 6, fontWeight: 600,
                      background: st.bg, color: st.fg,
                    }}>
                      {st.label} · {month}/{compactDays(p.days)}
                    </span>
                  )
                })}
                {it.weekly_fixed_off.length > 0 && (
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 6, fontWeight: 600,
                    background: '#dbeafe', color: '#1e40af',
                  }}>
                    주차요일제 · 매주 {it.weekly_fixed_off.join('·')} 오프
                  </span>
                )}
                {it.leftover && (
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 6,
                    background: '#f1f5f9', color: '#64748b',
                  }}>
                    미해석: {it.leftover}
                  </span>
                )}
              </div>
            </div>
          </label>
        ))}

        {reviewOnly.length > 0 && (
          <div style={{
            marginTop: 8, padding: '9px 12px', borderRadius: 8,
            background: '#fffbeb', border: '1px solid #fde68a',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 5 }}>
              사람이 직접 확인해야 하는 항목 {reviewOnly.length}건
            </div>
            {reviewOnly.map(it => (
              <div key={it.index} style={{ fontSize: 11, color: '#78350f', padding: '2px 0' }}>
                <b>{it.name}</b> — {it.leftover}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 액션 */}
      <div style={{
        padding: '10px 16px', borderTop: '1px solid var(--color-border-tertiary)',
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <button onClick={() => onApply(selected)} disabled={applying || selected.length === 0}
          style={{
            padding: '9px 18px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 700,
            background: applying || selected.length === 0 ? '#94a3b8' : '#4f46e5',
            color: '#fff', cursor: applying || selected.length === 0 ? 'not-allowed' : 'pointer',
          }}>
          {applying ? '반영 중...' : `선택한 ${selected.length}건 반영`}
        </button>
        <button onClick={onCancel} style={{
          padding: '9px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
          background: 'none', border: '0.5px solid var(--color-border-secondary)',
          color: 'var(--color-text-secondary)',
        }}>
          건너뛰기
        </button>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          반영하면 해당 날짜 희망근무에 순위 가중치가 붙습니다
        </span>
      </div>
    </div>
  )
}
