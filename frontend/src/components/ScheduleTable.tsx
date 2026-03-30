import type { Nurse, ScheduleResult, ConstraintConfig, ShiftType, Holiday } from '../types'
import { SHIFT_COLOR, GROUP_COLOR, GROUP_LABEL } from '../types'

interface Props {
  result: ScheduleResult
  nurses: Nurse[]
  config: ConstraintConfig
  holidays: Holiday[]
  filterGroup: string
}

const DOW = ['일','월','화','수','목','금','토']

function getDayType(year: number, month: number, day: number, holidayDays: Set<number>) {
  if (holidayDays.has(day)) return 'sunday'
  const wd = new Date(year, month - 1, day).getDay()
  return wd === 6 ? 'saturday' : wd === 0 ? 'sunday' : 'weekday'
}

function thBase(): React.CSSProperties {
  return {
    background: '#1e293b',
    color: '#cbd5e1',
    fontWeight: 600,
    padding: '5px 3px',
    textAlign: 'center',
    border: '0.5px solid #334155',
    fontSize: 10,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
  }
}

function getNurseAttr(n: Nurse): string {
  if (n.is_night_dedicated) return 'N전담'
  if (n.can_two_shift)      return '2교대'
  if (n.is_part_time)       return '주2일'
  return '·'
}

export default function ScheduleTable({ result, nurses, config, holidays, filterGroup }: Props) {
  const { year, month } = config
  const numDays     = new Date(year, month, 0).getDate()
  const days        = Array.from({ length: numDays }, (_, i) => i + 1)
  const holidayDays = new Set(holidays.map(h => h.day))

  const minStaff = {
    weekday:  config.min_staff_weekday,
    saturday: config.min_staff_saturday,
    sunday:   config.min_staff_sunday,
  }

  const displayNurses = filterGroup
    ? nurses.filter(n => n.group === filterGroup)
    : nurses

  const STAT_SHIFTS = ['D','E','N','6D','6N','EDU','O'] as const

  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
        <thead>
          {/* 타이틀 행 */}
          <tr>
            <th colSpan={3} style={{ ...thBase(), textAlign: 'left', padding: '7px 12px' }}>
              <span style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>
                {year}년 {month}월 듀티표
              </span>
              <span style={{ color: '#64748b', fontSize: 11, marginLeft: 14 }}>
                ^ = 희망 반영 &nbsp;·&nbsp; 붉은색 = 최소인원 미달
              </span>
            </th>
            <th colSpan={numDays} style={{ ...thBase(), background: '#1e293b' }} />
            <th colSpan={11} style={{ ...thBase(), background: '#1e293b' }} />
          </tr>
          {/* 날짜 헤더 */}
          <tr>
            <th style={{ ...thBase(), minWidth: 36 }}>그룹</th>
            <th style={{ ...thBase(), minWidth: 72 }}>이름</th>
            <th style={{ ...thBase(), minWidth: 44 }}>속성</th>
            {days.map(d => {
              const dt  = getDayType(year, month, d, holidayDays)
              const dow = new Date(year, month - 1, d).getDay()
              const wk  = dt !== 'weekday'
              const hd  = holidayDays.has(d)
              return (
                <th key={d} title={hd ? holidays.find(h => h.day === d)?.name : undefined}
                  style={{
                    ...thBase(),
                    minWidth: 26,
                    color: hd ? '#fca5a5' : wk ? '#a5b4fc' : '#cbd5e1',
                    background: hd ? '#450a0a' : wk ? '#1e3a5f' : '#1e293b',
                  }}>
                  {d}<br/>
                  <span style={{ fontSize: 9, fontWeight: 400 }}>{DOW[dow]}</span>
                  {hd && <span style={{ fontSize: 8, display: 'block', color: '#fca5a5' }}>공</span>}
                </th>
              )
            })}
            {[...STAT_SHIFTS, '야간','근무','시간','리메인','요청'].map(h => (
              <th key={h} style={{ ...thBase(), minWidth: 28 }}>{h}</th>
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
            const attrClr = n.is_night_dedicated ? '#4c1d95'
                          : n.can_two_shift ? '#1e3a8a'
                          : n.is_part_time  ? '#92400e'
                          : 'transparent'

            return (
              <tr key={n.id} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                {/* 그룹 */}
                <td style={{
                  padding: '3px 6px', textAlign: 'center', fontSize: 10, fontWeight: 700,
                  borderLeft: `3px solid ${grpClr}`,
                  background: grpClr + '18',
                  color: grpClr,
                }}>
                  {GROUP_LABEL[n.group].slice(0, 2)}
                </td>
                {/* 이름 */}
                <td style={{
                  padding: '3px 8px', whiteSpace: 'nowrap', fontWeight: 600, fontSize: 12,
                  background: 'var(--color-background-primary)',
                }}>
                  {n.is_night_dedicated ? '★ ' : ''}{n.name}
                </td>
                {/* 속성 */}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 9,
                  color: attrClr,
                  background: 'var(--color-background-primary)',
                }}>
                  {attr}
                </td>

                {/* 근무 셀 */}
                {days.map(d => {
                  const sh    = (dayMap[String(d)] ?? 'O') as ShiftType
                  const isReq = reqMap[d] === sh
                  const clr   = SHIFT_COLOR[sh] ?? SHIFT_COLOR['O']
                  const { bg, text } = clr
                  const dt    = getDayType(year, month, d, holidayDays)
                  const wkBg  = dt !== 'weekday' && sh === 'O' ? '#eef2ff' : undefined

                  return (
                    <td key={d} style={{
                      padding: 0, textAlign: 'center',
                      background: wkBg ?? bg,
                      border: '0.5px solid rgba(0,0,0,0.06)',
                    }}>
                      <div style={{
                        width: 26, height: 22,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: isReq ? 700 : 400,
                        color: text, position: 'relative',
                      }}>
                        {sh !== 'O' ? sh : ''}
                        {isReq && (
                          <span style={{ fontSize: 7, position: 'absolute', top: 1, right: 1, color: text }}>^</span>
                        )}
                      </div>
                    </td>
                  )
                })}

                {/* 통계 — shift 카운트 */}
                {st && STAT_SHIFTS.map(s => (
                  <td key={s} style={{
                    padding: '3px 2px', textAlign: 'center', fontSize: 10, fontWeight: 500,
                    color: (SHIFT_COLOR[s] ?? SHIFT_COLOR['O']).text,
                    background: 'var(--color-background-secondary, #f8f8f6)',
                  }}>
                    {st.counts[s] ?? 0}
                  </td>
                ))}
                {/* 야간 합계 (N+6N) */}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontWeight: 700, fontSize: 11,
                  color: '#7c3aed',
                  background: 'var(--color-background-secondary)',
                }}>
                  {st?.total_nights ?? 0}
                </td>
                {/* 총 근무 */}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontWeight: 700, fontSize: 11,
                  background: 'var(--color-background-secondary)',
                }}>
                  {st?.total_work ?? 0}
                </td>
                {/* 총 시간 */}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 10,
                  color: st && st.total_hours < st.target_hours - 8 ? '#dc2626' : 'var(--color-text-secondary)',
                  background: 'var(--color-background-secondary)',
                  whiteSpace: 'nowrap',
                }}>
                  {st ? `${st.total_hours}h` : ''}
                </td>
                {/* 리메인 */}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 11, fontWeight: 700,
                  color: st == null ? 'var(--color-text-secondary)'
                       : st.remain > 0 ? '#ea580c'
                       : st.remain < 0 ? '#2563eb'
                       : 'var(--color-text-secondary)',
                  background: 'var(--color-background-secondary)',
                }}>
                  {st != null ? (st.remain > 0 ? `+${st.remain}` : st.remain === 0 ? '0' : `${st.remain}`) : ''}
                </td>
                {/* 요청 달성 */}
                <td style={{
                  padding: '3px 4px', textAlign: 'center', fontSize: 11,
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-background-secondary)',
                }}>
                  {st?.request_rate ?? ''}
                </td>
              </tr>
            )
          })}

          {/* 일별 D/E/N 합계 행 (6D/6N pairs 반영) */}
          {(['D','E','N'] as const).map(sh => (
            <tr key={`sum-${sh}`}>
              <td colSpan={3} style={{
                padding: '3px 10px', fontSize: 11, fontWeight: 700,
                textAlign: 'right', color: SHIFT_COLOR[sh].text,
                background: 'var(--color-background-secondary)',
              }}>
                {sh} 합계
              </td>
              {days.map(d => {
                const dt    = getDayType(year, month, d, holidayDays)
                const pairs = nurses.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === '6D').length
                const cnt   = nurses.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === sh).length + pairs
                const mn    = (minStaff[dt] as any)[sh] ?? 0
                const ok    = cnt >= mn
                return (
                  <td key={d} style={{
                    textAlign: 'center', fontSize: 10, fontWeight: 600, padding: '2px 0',
                    background: ok ? '#d1fae5' : '#fee2e2',
                    color: ok ? '#065f46' : '#991b1b',
                    border: '0.5px solid rgba(0,0,0,0.06)',
                  }}>
                    {cnt}
                    <span style={{ fontSize: 8, opacity: 0.7 }}>/{mn}</span>
                  </td>
                )
              })}
              <td colSpan={11} style={{ background: 'var(--color-background-secondary)' }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
