import { useState } from 'react'
import type { Nurse, ScheduleResult, ConstraintConfig, ShiftType, Holiday } from '../types'
import { SHIFT_COLOR, GROUP_COLOR, GROUP_LABEL, weekdayKey } from '../types'
import { color, radius } from '../theme'

interface Props {
  result: ScheduleResult
  nurses: Nurse[]
  config: ConstraintConfig
  holidays: Holiday[]
  filterGroup: string
  searchName: string
}

const DOW = ['일','월','화','수','목','금','토']

// sticky 좌측 열 너비
const W_GRP = 42, W_NAME = 92, W_ATTR = 50

function thBase(): React.CSSProperties {
  return {
    background: color.dark,
    color: '#c4cad4',
    fontWeight: 700,
    padding: '6px 3px',
    textAlign: 'center',
    border: `0.5px solid #313842`,
    fontSize: 10,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
  }
}

function getNurseAttr(n: Nurse): { label: string; color: string } {
  if (n.is_night_dedicated)             return { label: 'N전담',  color: color.purpleStrong }
  if (n.can_two_shift)                  return { label: '2교대',  color: color.accentStrong }
  if (n.is_part_time)                   return { label: '주2일',  color: color.warningStrong }
  if (n.is_preceptee)                   return { label: `프셉티${n.preceptor_subgroup ?? ''}`, color: '#d6336c' }
  if (n.preceptor_subgroup)             return { label: `프셉터${n.preceptor_subgroup}`, color: color.purple }
  return { label: '·', color: color.textTertiary }
}

export default function ScheduleTable({ result, nurses, config, holidays, filterGroup, searchName }: Props) {
  const { year, month } = config
  const numDays     = new Date(year, month, 0).getDate()
  const days        = Array.from({ length: numDays }, (_, i) => i + 1)
  const holidayDays = new Set(holidays.map(h => h.day))
  const [hoverRow, setHoverRow] = useState<number | null>(null)

  const displayNurses = nurses.filter(n =>
    (!filterGroup || n.group === filterGroup) &&
    (!searchName || n.name.toLowerCase().includes(searchName.toLowerCase()))
  )

  const STAT_SHIFTS = ['D','E','N','6D','6N','EDU','O'] as const
  const STAT_COLS = STAT_SHIFTS.length + 5   // + 야간·근무·시간·리메인·요청

  // 프리셉터 지원일: 서브그룹 → 지원일 set (프리셉터/프리셉티 모두 ◆ 표시)
  const supportDays = result.support_days ?? {}

  return (
    <div style={{
      overflow: 'auto',
      maxHeight: 'calc(100vh - 250px)',
      borderRadius: radius.lg,
      border: `1px solid ${color.border}`,
      boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 4px 14px rgba(15,23,42,0.05)',
    }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ ...thBase(), position: 'sticky', top: 0, left: 0, zIndex: 5, minWidth: W_GRP, width: W_GRP }}>그룹</th>
            <th style={{ ...thBase(), position: 'sticky', top: 0, left: W_GRP, zIndex: 5, minWidth: W_NAME, width: W_NAME }}>이름</th>
            <th style={{ ...thBase(), position: 'sticky', top: 0, left: W_GRP + W_NAME, zIndex: 5, minWidth: W_ATTR, width: W_ATTR }}>속성</th>
            {days.map(d => {
              const dt  = weekdayKey(year, month, d, holidayDays)
              const dow = new Date(year, month - 1, d).getDay()
              const wk  = dt === 'saturday' || dt === 'sunday'
              const hd  = holidayDays.has(d)
              return (
                <th key={d} title={hd ? holidays.find(h => h.day === d)?.name : undefined}
                  style={{
                    ...thBase(),
                    position: 'sticky', top: 0, zIndex: 3,
                    minWidth: 27,
                    color: hd ? '#ff8080' : wk ? '#8fb4ff' : '#c4cad4',
                    background: hd ? '#3d1b1e' : wk ? '#1e2a42' : color.dark,
                  }}>
                  {d}<br/>
                  <span style={{ fontSize: 9, fontWeight: 400 }}>{DOW[dow]}</span>
                  {hd && <span style={{ fontSize: 8, display: 'block', color: '#ff8080' }}>공</span>}
                </th>
              )
            })}
            {[...STAT_SHIFTS, '야간','근무','시간','리메인','요청'].map(h => (
              <th key={h} style={{ ...thBase(), position: 'sticky', top: 0, zIndex: 3, minWidth: 30 }}>{h}</th>
            ))}
          </tr>
        </thead>

        <tbody>
          {displayNurses.map(n => {
            const dayMap  = result.schedule[n.name] ?? {}
            const st      = result.stats[n.name]
            const reqMap  = Object.fromEntries(n.preferred_requests.map(r => [r.day, r.shift]))
            const grpClr  = GROUP_COLOR[n.group]
            const attr    = getNurseAttr(n)
            const hovered = hoverRow === n.id
            const rowBg   = hovered ? color.accentBg : color.bg
            const supSet  = new Set(
              n.preceptor_subgroup ? (supportDays[n.preceptor_subgroup] ?? []) : []
            )

            return (
              <tr key={n.id}
                onMouseEnter={() => setHoverRow(n.id)}
                onMouseLeave={() => setHoverRow(null)}>
                {/* 그룹 */}
                <td style={{
                  position: 'sticky', left: 0, zIndex: 2,
                  padding: '3px 6px', textAlign: 'center', fontSize: 10, fontWeight: 700,
                  borderLeft: `3px solid ${grpClr}`,
                  borderBottom: `0.5px solid ${color.border}`,
                  background: rowBg, color: grpClr,
                  minWidth: W_GRP, width: W_GRP,
                }}>
                  {GROUP_LABEL[n.group].slice(0, 2)}
                </td>
                {/* 이름 */}
                <td style={{
                  position: 'sticky', left: W_GRP, zIndex: 2,
                  padding: '3px 8px', whiteSpace: 'nowrap', fontWeight: 700, fontSize: 12,
                  borderBottom: `0.5px solid ${color.border}`,
                  background: rowBg, color: color.text,
                  minWidth: W_NAME, width: W_NAME, overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {n.is_night_dedicated ? '★ ' : ''}{n.name}
                </td>
                {/* 속성 */}
                <td style={{
                  position: 'sticky', left: W_GRP + W_NAME, zIndex: 2,
                  padding: '3px 4px', textAlign: 'center', fontSize: 9,
                  borderBottom: `0.5px solid ${color.border}`,
                  borderRight: `1px solid ${color.border}`,
                  color: attr.color, background: rowBg,
                  minWidth: W_ATTR, width: W_ATTR,
                }}>
                  {attr.label}
                </td>

                {/* 근무 셀 */}
                {days.map(d => {
                  const sh     = (dayMap[String(d)] ?? 'O') as ShiftType
                  const req    = reqMap[d]
                  const isReq  = req === sh                       // 희망 반영
                  const denied = req !== undefined && req !== sh  // 희망 미반영
                  const isSup  = supSet.has(d)                    // 프리셉터 지원일
                  const clr    = SHIFT_COLOR[sh] ?? SHIFT_COLOR['O']
                  const dt     = weekdayKey(year, month, d, holidayDays)
                  const wk     = dt === 'saturday' || dt === 'sunday'
                  const bg     = sh === 'O'
                    ? (wk ? '#eef2ff' : hovered ? color.accentBg : color.bg)
                    : clr.bg
                  const tooltip = denied
                    ? `${n.name} ${d}일: 희망 ${req === 'O' ? '오프' : req} → 배정 ${sh === 'O' ? '오프' : sh}`
                    : isSup ? `프리셉터 지원일 (${n.preceptor_subgroup}조)` : undefined

                  return (
                    <td key={d} title={tooltip} style={{
                      padding: 0, textAlign: 'center',
                      background: bg,
                      borderBottom: '0.5px solid rgba(15,23,42,0.06)',
                      borderRight: '0.5px solid rgba(15,23,42,0.04)',
                      outline: isSup ? `2px solid ${color.warning}` : undefined,
                      outlineOffset: isSup ? -2 : undefined,
                    }}>
                      <div style={{
                        width: 27, height: 22,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: isReq || isSup ? 700 : 400,
                        color: clr.text, position: 'relative',
                        cursor: tooltip ? 'help' : undefined,
                      }}>
                        {sh !== 'O' ? sh : ''}
                        {isReq && (
                          <span style={{ fontSize: 7, position: 'absolute', top: 1, right: 1, color: clr.text }}>^</span>
                        )}
                        {denied && (
                          <span style={{
                            fontSize: 8, position: 'absolute', top: 0, right: 1,
                            color: color.danger, fontWeight: 700,
                          }}>✕</span>
                        )}
                      </div>
                    </td>
                  )
                })}

                {/* 통계 — shift 카운트 */}
                {STAT_SHIFTS.map(s => (
                  <td key={s} style={{
                    padding: '3px 2px', textAlign: 'center', fontSize: 10, fontWeight: 600,
                    color: (SHIFT_COLOR[s] ?? SHIFT_COLOR['O']).text,
                    background: color.bgMuted,
                    borderBottom: `0.5px solid ${color.border}`,
                  }}>
                    {st?.counts[s] ?? 0}
                  </td>
                ))}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontWeight: 700, fontSize: 11,
                  color: color.purpleStrong, background: color.bgMuted,
                  borderBottom: `0.5px solid ${color.border}`,
                }}>
                  {st?.total_nights ?? 0}
                </td>
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontWeight: 700, fontSize: 11,
                  background: color.bgMuted, color: color.text,
                  borderBottom: `0.5px solid ${color.border}`,
                }}>
                  {st?.total_work ?? 0}
                </td>
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 10,
                  color: color.textSecondary,
                  background: color.bgMuted,
                  borderBottom: `0.5px solid ${color.border}`,
                  whiteSpace: 'nowrap',
                }}>
                  {st ? `${st.total_hours}h` : ''}
                </td>
                <td title="리메인: 표준 근무일 대비 초과(+)/미달(−) 일수" style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 11, fontWeight: 700,
                  color: st == null ? color.textSecondary
                       : st.remain > 0 ? color.warningStrong
                       : st.remain < 0 ? color.accentStrong
                       : color.textSecondary,
                  background: color.bgMuted,
                  borderBottom: `0.5px solid ${color.border}`,
                }}>
                  {st != null ? (st.remain > 0 ? `+${st.remain}` : `${st.remain}`) : ''}
                </td>
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 11,
                  color: color.textSecondary,
                  background: color.bgMuted,
                  borderBottom: `0.5px solid ${color.border}`,
                  whiteSpace: 'nowrap',
                }}>
                  {st?.request_rate ?? ''}
                </td>
              </tr>
            )
          })}

          {/* 일별 D/E/N 합계 행 (프리셉티 제외 = 솔버 기준, 6D→D / 6N→N 합산) */}
          {(['D','E','N'] as const).map(sh => (
            <tr key={`sum-${sh}`}>
              <td colSpan={3} title="프리셉티 제외 인원 (솔버의 최소인원 기준과 동일)" style={{
                position: 'sticky', left: 0, zIndex: 2,
                padding: '3px 10px', fontSize: 11, fontWeight: 700,
                textAlign: 'right', color: SHIFT_COLOR[sh].text,
                background: color.bgMuted,
                borderBottom: `0.5px solid ${color.border}`,
                borderRight: `1px solid ${color.border}`,
              }}>
                {sh} 합계
              </td>
              {days.map(d => {
                const dt      = weekdayKey(year, month, d, holidayDays)
                const counted = nurses.filter(n => !n.is_preceptee)
                const extra   = sh === 'D'
                  ? counted.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === '6D').length
                  : sh === 'N'
                  ? counted.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === '6N').length
                  : 0
                const cnt = counted.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === sh).length + extra
                const mn  = (config.min_staff[dt] as any)?.[sh] ?? 0
                const ok  = cnt >= mn
                return (
                  <td key={d} style={{
                    textAlign: 'center', fontSize: 10, fontWeight: 700, padding: '2px 0',
                    background: ok ? color.successBg : color.dangerBg,
                    color: ok ? color.successStrong : color.dangerStrong,
                    borderBottom: '0.5px solid rgba(15,23,42,0.06)',
                  }}>
                    {cnt}
                    <span style={{ fontSize: 8, opacity: 0.7 }}>/{mn}</span>
                  </td>
                )
              })}
              <td colSpan={STAT_COLS} style={{ background: color.bgMuted }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
