import { useMemo, useState } from 'react'
import type { Nurse, ScheduleResult, ConstraintConfig, Holiday } from '../types'
import { SHIFT_COLOR } from '../types'
import { color, radius, chip, button } from '../theme'

interface Props {
  result: ScheduleResult
  nurses: Nurse[]
  config: ConstraintConfig
  holidays: Holiday[]
  elapsed: number
  onDownload: () => void
}

interface Denied {
  name: string
  day: number
  wanted: string
  got: string
}

function getDayType(year: number, month: number, day: number, holidayDays: Set<number>) {
  if (holidayDays.has(day)) return 'sunday'
  const wd = new Date(year, month - 1, day).getDay()
  return wd === 6 ? 'saturday' : wd === 0 ? 'sunday' : 'weekday'
}

function Card({ children, onClick, clickable }: { children: React.ReactNode; onClick?: () => void; clickable?: boolean }) {
  return (
    <div onClick={onClick} style={{
      flex: 1, minWidth: 140, padding: '14px 18px', borderRadius: radius.lg,
      background: color.bg, border: `1px solid ${color.border}`,
      cursor: clickable ? 'pointer' : 'default',
    }}>
      {children}
    </div>
  )
}

const cardLabel: React.CSSProperties = {
  fontSize: 12, color: color.textSecondary, marginBottom: 5, fontWeight: 600,
}
const cardValue: React.CSSProperties = { fontSize: 24, fontWeight: 800, color: color.text, letterSpacing: '-0.3px' }

export default function ResultSummary({ result, nurses, config, holidays, elapsed, onDownload }: Props) {
  const [showDenied, setShowDenied] = useState(false)

  const { reqTotal, reqOk, deniedList, remainMin, remainMax, shortSlots } = useMemo(() => {
    let reqTotal = 0, reqOk = 0
    const deniedList: Denied[] = []
    for (const n of nurses) {
      const row = result.schedule[n.name] ?? {}
      for (const r of n.preferred_requests) {
        reqTotal++
        const got = row[String(r.day)] ?? 'O'
        if (got === r.shift) reqOk++
        else deniedList.push({ name: n.name, day: r.day, wanted: r.shift, got })
      }
    }
    deniedList.sort((a, b) => a.day - b.day)

    // 리메인 범위: 풀타임(N전담·주2일 제외)
    const rems = nurses
      .filter(n => !n.is_night_dedicated && !n.is_part_time)
      .map(n => result.stats[n.name]?.remain)
      .filter((v): v is number => v != null)
    const remainMin = rems.length ? Math.min(...rems) : 0
    const remainMax = rems.length ? Math.max(...rems) : 0

    // 최소인원 미달 슬롯 (프리셉티 제외, 6D→D / 6N→N)
    const numDays = new Date(config.year, config.month, 0).getDate()
    const holidayDays = new Set(holidays.map(h => h.day))
    const minStaff = {
      weekday:  config.min_staff_weekday,
      saturday: config.min_staff_saturday,
      sunday:   config.min_staff_sunday,
    }
    const counted = nurses.filter(n => !n.is_preceptee)
    let shortSlots = 0
    for (let d = 1; d <= numDays; d++) {
      const dt = getDayType(config.year, config.month, d, holidayDays)
      for (const sh of ['D','E','N'] as const) {
        const extra = sh === 'D'
          ? counted.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === '6D').length
          : sh === 'N'
          ? counted.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === '6N').length
          : 0
        const cnt = counted.filter(n => (result.schedule[n.name]?.[String(d)] ?? 'O') === sh).length + extra
        if (cnt < ((minStaff[dt] as any)[sh] ?? 0)) shortSlots++
      }
    }
    return { reqTotal, reqOk, deniedList, remainMin, remainMax, shortSlots }
  }, [result, nurses, config, holidays])

  const rate = reqTotal > 0 ? Math.round((reqOk / reqTotal) * 100) : 100
  const rateColor = rate >= 85 ? color.successStrong : rate >= 70 ? color.warningStrong : color.dangerStrong

  return (
    <div style={{ marginBottom: 16 }}>
      {result.relaxed && (
        <div style={{
          marginBottom: 10, padding: '10px 16px', borderRadius: radius.md, fontSize: 12.5,
          background: color.warningBg, color: color.warningStrong, lineHeight: 1.6,
        }}>
          ⚠ 원래 조건으로는 표를 만들 수 없어 <b>{result.relaxed}</b> 후 생성했습니다.
          아래 지표를 특히 꼼꼼히 확인해주세요.
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* 희망 반영률 */}
        <Card clickable={deniedList.length > 0} onClick={() => deniedList.length && setShowDenied(v => !v)}>
          <div style={cardLabel}>희망 반영률</div>
          <div style={{ ...cardValue, color: rateColor }}>
            {rate}%
            <span style={{ fontSize: 12, fontWeight: 600, color: color.textSecondary, marginLeft: 6 }}>
              {reqOk}/{reqTotal}
            </span>
          </div>
          {deniedList.length > 0 && (
            <div style={{ fontSize: 11.5, color: color.dangerStrong, marginTop: 4, fontWeight: 600 }}>
              미반영 {deniedList.length}건 {showDenied ? '▲' : '▼'}
            </div>
          )}
        </Card>

        {/* 최소인원 */}
        <Card>
          <div style={cardLabel}>최소인원 미달</div>
          <div style={{ ...cardValue, color: shortSlots === 0 ? color.successStrong : color.dangerStrong }}>
            {shortSlots === 0 ? '없음 ✓' : `${shortSlots}슬롯`}
          </div>
        </Card>

        {/* 리메인 */}
        <Card>
          <div style={cardLabel} title="풀타임 기준 (N전담·주2일제 제외). +는 표준보다 초과 근무, −는 오프 초과">리메인 (풀타임)</div>
          <div style={{ ...cardValue, color: remainMax - remainMin <= 1 ? color.successStrong : color.warningStrong }}>
            {remainMin === remainMax
              ? (remainMin > 0 ? `+${remainMin}` : `${remainMin}`)
              : `${remainMin > 0 ? '+' : ''}${remainMin} ~ ${remainMax > 0 ? '+' : ''}${remainMax}`}
            <span style={{ fontSize: 12, fontWeight: 600, color: color.textSecondary, marginLeft: 6 }}>
              편차 {remainMax - remainMin}일
            </span>
          </div>
        </Card>

        {/* 소요시간 */}
        <Card>
          <div style={cardLabel}>생성 소요</div>
          <div style={cardValue}>{elapsed > 0 ? `${elapsed}초` : '—'}</div>
        </Card>

        {/* 다운로드 */}
        <button onClick={onDownload} style={button('primary', {
          minWidth: 150, padding: '14px 20px', fontSize: 14,
          background: color.success,
        })}>
          📥 엑셀 다운로드
        </button>
      </div>

      {/* 미반영 희망 목록 */}
      {showDenied && deniedList.length > 0 && (
        <div style={{
          marginTop: 10, padding: '13px 16px', borderRadius: radius.lg,
          background: color.dangerBg,
        }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: color.dangerStrong, marginBottom: 9 }}>
            미반영 희망 {deniedList.length}건 — 표에서 ✕ 표시된 칸입니다
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {deniedList.map((d, i) => {
              const wc = SHIFT_COLOR[d.wanted] ?? SHIFT_COLOR['O']
              return (
                <span key={i} style={chip(color.bg, '#7f1d1d', { border: `1px solid ${color.dangerBg}` })}>
                  <b>{d.name}</b> {d.day}일 :{' '}
                  <span style={{ color: wc.text, fontWeight: 700 }}>
                    {d.wanted === 'O' ? '오프' : d.wanted}
                  </span>
                  {' → '}
                  {d.got === 'O' ? '오프' : d.got}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
