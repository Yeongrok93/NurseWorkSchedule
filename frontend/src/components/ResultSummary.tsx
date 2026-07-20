import { useMemo, useState } from 'react'
import type { Nurse, ScheduleResult, ConstraintConfig, Holiday } from '../types'
import { SHIFT_COLOR } from '../types'

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

  const card: React.CSSProperties = {
    flex: 1, minWidth: 130, padding: '12px 16px', borderRadius: 10,
    background: 'var(--color-background-primary)',
    border: '0.5px solid var(--color-border-secondary)',
  }
  const cardLabel: React.CSSProperties = {
    fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4,
  }
  const cardValue: React.CSSProperties = { fontSize: 20, fontWeight: 700 }

  return (
    <div style={{ marginBottom: 14 }}>
      {result.relaxed && (
        <div style={{
          marginBottom: 10, padding: '9px 14px', borderRadius: 8, fontSize: 12,
          background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
        }}>
          ⚠ 원래 조건으로는 표를 만들 수 없어 <b>{result.relaxed}</b> 후 생성했습니다.
          아래 지표를 특히 꼼꼼히 확인해주세요.
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* 희망 반영률 */}
        <div style={{ ...card, cursor: deniedList.length ? 'pointer' : 'default' }}
          onClick={() => deniedList.length && setShowDenied(v => !v)}
          title={deniedList.length ? '클릭하면 미반영 목록을 보여줍니다' : undefined}>
          <div style={cardLabel}>희망 반영률</div>
          <div style={{ ...cardValue, color: rate >= 85 ? '#059669' : rate >= 70 ? '#d97706' : '#dc2626' }}>
            {rate}%
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginLeft: 6 }}>
              {reqOk}/{reqTotal}
            </span>
          </div>
          {deniedList.length > 0 && (
            <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2 }}>
              미반영 {deniedList.length}건 {showDenied ? '▲' : '▼'}
            </div>
          )}
        </div>

        {/* 최소인원 */}
        <div style={card}>
          <div style={cardLabel}>최소인원 미달</div>
          <div style={{ ...cardValue, color: shortSlots === 0 ? '#059669' : '#dc2626' }}>
            {shortSlots === 0 ? '없음 ✓' : `${shortSlots}슬롯`}
          </div>
        </div>

        {/* 리메인 */}
        <div style={card} title="풀타임 기준 (N전담·주2일제 제외). +는 표준보다 초과 근무, −는 오프 초과">
          <div style={cardLabel}>리메인 (풀타임)</div>
          <div style={{
            ...cardValue,
            color: remainMax - remainMin <= 1 ? '#059669' : '#d97706',
          }}>
            {remainMin === remainMax
              ? (remainMin > 0 ? `+${remainMin}` : `${remainMin}`)
              : `${remainMin > 0 ? '+' : ''}${remainMin} ~ ${remainMax > 0 ? '+' : ''}${remainMax}`}
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)', marginLeft: 6 }}>
              편차 {remainMax - remainMin}일
            </span>
          </div>
        </div>

        {/* 소요시간 */}
        <div style={card}>
          <div style={cardLabel}>생성 소요</div>
          <div style={cardValue}>{elapsed > 0 ? `${elapsed}초` : '—'}</div>
        </div>

        {/* 다운로드 */}
        <button onClick={onDownload} style={{
          minWidth: 150, padding: '12px 20px', borderRadius: 10,
          background: '#059669', color: '#fff', border: 'none',
          fontSize: 14, fontWeight: 700, cursor: 'pointer',
        }}>
          📥 엑셀 다운로드
        </button>
      </div>

      {/* 미반영 희망 목록 */}
      {showDenied && deniedList.length > 0 && (
        <div style={{
          marginTop: 10, padding: '12px 16px', borderRadius: 10,
          background: '#fef2f2', border: '1px solid #fecaca',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#991b1b', marginBottom: 8 }}>
            미반영 희망 {deniedList.length}건 — 표에서 ✕ 표시된 칸입니다
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {deniedList.map((d, i) => {
              const wc = SHIFT_COLOR[d.wanted] ?? SHIFT_COLOR['O']
              return (
                <span key={i} style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 6,
                  background: '#fff', border: '0.5px solid #fca5a5', color: '#7f1d1d',
                }}>
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
