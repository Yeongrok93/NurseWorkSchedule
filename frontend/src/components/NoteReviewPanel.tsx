import { useState } from 'react'
import type { NoteInterpretation, NoteInterpretResult } from '../types'
import { color, radius, chip, button } from '../theme'

interface Props {
  result: NoteInterpretResult
  month: number
  onApply: (items: NoteInterpretation[]) => void
  onCancel: () => void
  applying: boolean
}

const RANK_STYLE: Record<number, { bg: string; fg: string; label: string }> = {
  1: { bg: color.dangerBg, fg: color.dangerStrong, label: '1순위' },
  2: { bg: color.warningBg, fg: color.warningStrong, label: '2순위' },
  3: { bg: color.accentBg, fg: color.accentStrong, label: '3순위' },
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
  // 항목별 반영 여부 (기본 전부 체크) — 토스 거래내역 자동분류 확인 패턴
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
      marginBottom: 16, borderRadius: radius.lg, overflow: 'hidden',
      border: `1px solid ${color.border}`, background: color.bg,
      boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 4px 14px rgba(15,23,42,0.05)',
    }}>
      {/* 헤더 */}
      <div style={{
        padding: '16px 18px 14px', borderBottom: `1px solid ${color.border}`,
        display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: color.text, marginBottom: 4 }}>
            특기사항 자동 해석
          </div>
          <div style={{ fontSize: 12, color: color.textSecondary }}>
            {usable.length}건을 제안으로 만들었어요 · {selected.length}건 선택됨
          </div>
        </div>
        <span style={chip(
          result.engine === 'llm' ? color.purpleBg : color.bgSubtle,
          result.engine === 'llm' ? color.purpleStrong : color.textSecondary,
        )}>
          {result.engine === 'llm' ? '✨ AI 해석' : '규칙 기반 해석'}
        </span>
        <button onClick={onCancel} style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 20,
          color: color.textTertiary, lineHeight: 1, padding: 0,
        }}>×</button>
      </div>

      {result.warning && (
        <div style={{
          padding: '9px 18px', fontSize: 12, background: color.warningBg, color: color.warningStrong,
          borderBottom: `1px solid ${color.border}`,
        }}>
          ⚠ {result.warning}
        </div>
      )}

      <div style={{ padding: '10px 18px 4px', fontSize: 12, color: color.textSecondary, lineHeight: 1.6 }}>
        문장을 <b style={{ color: color.text }}>제안</b>으로 바꾼 것입니다. 최소인원·연속근무 같은 근무 규칙은 바뀌지 않아요.
        틀린 항목은 체크를 해제하세요.
      </div>

      {/* 해석 목록 — 거래내역 확인 리스트 패턴 */}
      <div style={{ maxHeight: 360, overflowY: 'auto', padding: '10px 12px' }}>
        {usable.map(it => {
          const on = !!enabled[it.index]
          return (
            <label key={it.index} style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              padding: '11px 12px', marginBottom: 4, borderRadius: radius.md, cursor: 'pointer',
              background: on ? color.bg : color.bgMuted,
              transition: 'background .12s',
            }}>
              <input type="checkbox" checked={on} style={{
                marginTop: 3, width: 16, height: 16, accentColor: color.accent, flexShrink: 0,
              }}
                onChange={e => setEnabled({ ...enabled, [it.index]: e.target.checked })} />
              <div style={{ flex: 1, minWidth: 0, opacity: on ? 1 : 0.5 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: color.text }}>{it.name}</span>
                  <span style={{ fontSize: 11.5, color: color.textTertiary }}>“{it.note}”</span>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                  {it.priority_requests.map((p, i) => {
                    const st = RANK_STYLE[p.rank] ?? RANK_STYLE[3]
                    return (
                      <span key={i} style={chip(st.bg, st.fg)}>
                        {st.label} · {month}/{compactDays(p.days)}
                      </span>
                    )
                  })}
                  {it.weekly_fixed_off.length > 0 && (
                    <span style={chip(color.successBg, color.successStrong)}>
                      매주 {it.weekly_fixed_off.join('·')} 오프
                    </span>
                  )}
                  {it.leftover && (
                    <span style={chip(color.bgSubtle, color.textSecondary)}>
                      미해석: {it.leftover}
                    </span>
                  )}
                </div>
              </div>
            </label>
          )
        })}

        {reviewOnly.length > 0 && (
          <div style={{
            marginTop: 8, padding: '11px 13px', borderRadius: radius.md,
            background: color.warningBg,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: color.warningStrong, marginBottom: 5 }}>
              사람이 직접 확인해야 하는 항목 {reviewOnly.length}건
            </div>
            {reviewOnly.map(it => (
              <div key={it.index} style={{ fontSize: 11.5, color: color.warningStrong, padding: '2px 0' }}>
                <b>{it.name}</b> — {it.leftover}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 액션 */}
      <div style={{
        padding: '12px 18px', borderTop: `1px solid ${color.border}`,
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <button onClick={() => onApply(selected)} disabled={applying || selected.length === 0}
          style={button('primary', {
            padding: '10px 20px', fontSize: 13,
            background: applying || selected.length === 0 ? color.borderStrong : color.accent,
            cursor: applying || selected.length === 0 ? 'not-allowed' : 'pointer',
          })}>
          {applying ? '반영 중...' : `선택한 ${selected.length}건 반영`}
        </button>
        <button onClick={onCancel} style={button('ghost', { padding: '10px 16px', fontSize: 13 })}>
          건너뛰기
        </button>
        <span style={{ fontSize: 11, color: color.textTertiary }}>
          반영하면 해당 날짜 희망근무에 순위 가중치가 붙습니다
        </span>
      </div>
    </div>
  )
}
