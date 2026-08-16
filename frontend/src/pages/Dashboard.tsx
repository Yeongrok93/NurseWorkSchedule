import { useEffect, useRef, useState } from 'react'
import type {
  Nurse, ConstraintConfig, ScheduleResult, Holiday, SolverStatus, GroupType, ShiftType,
  NoteInterpretResult, NoteInterpretation,
} from '../types'
import { GROUP_LABEL, GROUP_COLOR, SHIFT_COLOR } from '../types'
import {
  startSchedule, connectJobWS, downloadExcel, getHolidays, analyzeInfeasibility,
  interpretNotes, applyNotes,
} from '../utils/api'
import { color, radius, chip, button } from '../theme'
import UploadPanel from '../components/UploadPanel'
import ConstraintPanel from '../components/ConstraintPanel'
import SolverProgress from '../components/SolverProgress'
import ScheduleTable from '../components/ScheduleTable'
import ResultSummary from '../components/ResultSummary'
import NoteReviewPanel from '../components/NoteReviewPanel'
import PrevMonthUpload from '../components/PrevMonthUpload'

const DEFAULT_MIN_STAFF: ConstraintConfig['min_staff'] = {
  monday:    { D: 7, E: 6, N: 6 },
  tuesday:   { D: 7, E: 6, N: 6 },
  wednesday: { D: 7, E: 6, N: 6 },
  thursday:  { D: 7, E: 6, N: 6 },
  friday:    { D: 7, E: 6, N: 6 },
  saturday:  { D: 6, E: 5, N: 5 },
  sunday:    { D: 5, E: 5, N: 5 },
}

const DEFAULT_CONFIG: ConstraintConfig = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  min_staff: DEFAULT_MIN_STAFF,
  max_consecutive_work: 5,
  night_dedicated_count: 14,
  max_first_year: 15,
  min_night_block: 2,
  max_night_block: 3,
  max_two_shift_pairs_per_day: 2,
  max_d6_block: 2,
  max_n6_block: 2,
  night_min_gap: 10,
  night_max_count: 7,
  time_limit_seconds: 90,
}

const GROUPS: GroupType[] = ['charge', 'leader', 'mid', 'junior', 'first']

// ─── localStorage 유틸 ────────────────────────────────────────────────────────

function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

function saveLS(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch { /* 저장 실패는 무시 */ }
}

/** 구버전(평일/토/일 3구간) 저장값 → 요일별 7구간으로 마이그레이션 */
function migrateConfig(raw: any): Partial<ConstraintConfig> {
  if (!raw) return {}
  if (raw.min_staff && !raw.min_staff_weekday) return raw   // 이미 신버전
  if (raw.min_staff_weekday) {
    const { min_staff_weekday, min_staff_saturday, min_staff_sunday, ...rest } = raw
    return {
      ...rest,
      min_staff: {
        monday: min_staff_weekday, tuesday: min_staff_weekday, wednesday: min_staff_weekday,
        thursday: min_staff_weekday, friday: min_staff_weekday,
        saturday: min_staff_saturday, sunday: min_staff_sunday,
      },
    }
  }
  return raw
}

// ─── 토스트 ──────────────────────────────────────────────────────────────────

interface Toast { id: number; msg: string; kind: 'ok' | 'err' | 'info' }

const TOAST_META = {
  ok:   { icon: '✓', accent: color.success },
  err:  { icon: '!', accent: color.danger },
  info: { icon: 'i', accent: color.accent },
}

export default function Dashboard() {
  const [nurses,   setNurses]   = useState<Nurse[]>(() => loadLS('duty.nurses', []))
  const [config,   setConfig]   = useState<ConstraintConfig>(
    () => ({ ...DEFAULT_CONFIG, ...migrateConfig(loadLS('duty.config', {})) })
  )
  const [result,   setResult]   = useState<ScheduleResult | null>(() => loadLS('duty.result', null))
  const [jobId,    setJobId]    = useState<string | null>(() => loadLS('duty.jobId', null))
  const [status,   setStatus]   = useState<SolverStatus>(result ? 'done' : 'idle')
  const [elapsed,  setElapsed]  = useState(() => loadLS('duty.elapsed', 0))
  const [holidays, setHols]     = useState<Holiday[]>([])
  const [filterGrp, setFilterGrp] = useState('')
  const [searchName, setSearchName] = useState('')
  const [sideOpen, setSideOpen] = useState(true)
  const [activeTab, setActiveTab] = useState<'upload'|'nurses'|'constraints'>(
    () => (loadLS<Nurse[]>('duty.nurses', []).length > 0 ? 'nurses' : 'upload')
  )
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis,  setAnalysis]  = useState<any>(null)
  const [toasts,   setToasts]   = useState<Toast[]>([])
  // 특기사항 해석
  const [noteResult, setNoteResult] = useState<NoteInterpretResult | null>(null)
  const [noteBusy,   setNoteBusy]   = useState(false)
  const [apiKey,     setApiKey]     = useState<string>(() => loadLS('duty.apiKey', ''))

  const wsRef    = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const toastSeq = useRef(0)

  // ── 지속화 ──
  useEffect(() => { saveLS('duty.nurses', nurses) }, [nurses])
  useEffect(() => { saveLS('duty.config', config) }, [config])
  useEffect(() => { saveLS('duty.result', result) }, [result])
  useEffect(() => { saveLS('duty.jobId', jobId) }, [jobId])
  useEffect(() => { saveLS('duty.elapsed', elapsed) }, [elapsed])

  useEffect(() => {
    getHolidays(config.year, config.month).then(setHols).catch(() => setHols([]))
  }, [config.year, config.month])

  function toast(msg: string, kind: Toast['kind'] = 'info') {
    const id = ++toastSeq.current
    setToasts(t => [...t, { id, msg, kind }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }

  function clearTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  function shiftMonth(delta: number) {
    let y = config.year, m = config.month + delta
    if (m < 1)  { m = 12; y-- }
    if (m > 12) { m = 1;  y++ }
    setConfig({ ...config, year: y, month: m })
  }

  async function handleGenerate() {
    if (nurses.length === 0) {
      toast('간호사 명단을 먼저 입력해주세요', 'err')
      setActiveTab('upload')
      return
    }
    setStatus('pending'); setElapsed(0); setResult(null); setAnalysis(null)
    const start = Date.now()
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)
    try {
      const id = await startSchedule(nurses, config)
      setJobId(id)
      wsRef.current?.close()
      wsRef.current = connectJobWS(
        id,
        s  => setStatus(s as SolverStatus),
        r  => { setResult(r); setStatus('done'); clearTimer(); toast('듀티표 생성 완료', 'ok') },
        () => { setStatus('error'); clearTimer(); toast('생성 중 오류가 발생했습니다', 'err') },
      )
    } catch {
      setStatus('error'); clearTimer()
      toast('백엔드 서버에 연결할 수 없습니다', 'err')
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true)
    setAnalysis(null)
    toast('원인 분석은 제약을 하나씩 검사하므로 수 분 걸릴 수 있습니다', 'info')
    try {
      const r = await analyzeInfeasibility(nurses, config)
      setAnalysis(r)
    } catch {
      toast('분석 실패 — 백엔드 연결을 확인하세요', 'err')
    } finally {
      setAnalyzing(false)
    }
  }

  function handleDownload() {
    if (!jobId) { toast('먼저 듀티표를 생성해주세요', 'err'); return }
    downloadExcel(jobId, nurses, config)
      .then(() => toast('엑셀 다운로드 시작', 'ok'))
      .catch(() => toast('다운로드 실패 — 작업이 만료되었으면 다시 생성해주세요', 'err'))
  }

  async function handleInterpretNotes() {
    setNoteBusy(true)
    try {
      const r = await interpretNotes(nurses, config.year, config.month, apiKey || undefined)
      if (r.items.length === 0) {
        toast('해석할 특기사항이 없습니다', 'info')
      } else {
        setNoteResult(r)
        if (r.warning) toast(r.warning, 'err')
      }
    } catch {
      toast('특기사항 해석 실패 — 백엔드 연결을 확인하세요', 'err')
    } finally {
      setNoteBusy(false)
    }
  }

  async function handleApplyNotes(items: NoteInterpretation[]) {
    setNoteBusy(true)
    try {
      const updated = await applyNotes(nurses, items)
      setNurses(updated)
      setNoteResult(null)
      const ranked = updated.reduce(
        (s, n) => s + n.preferred_requests.filter(r => r.rank).length, 0)
      const weekly = updated.filter(n => (n.weekly_fixed_off ?? []).length > 0).length
      toast(`반영 완료 — 순위 ${ranked}건${weekly ? `, 주차요일제 ${weekly}명` : ''}`, 'ok')
    } catch {
      toast('반영 실패', 'err')
    } finally {
      setNoteBusy(false)
    }
  }

  function handleReset() {
    if (!confirm('명단·설정·결과를 모두 지우고 처음부터 시작할까요?')) return
    setNurses([]); setConfig(DEFAULT_CONFIG); setResult(null); setJobId(null)
    setStatus('idle'); setElapsed(0); setAnalysis(null); setFilterGrp(''); setSearchName('')
    setNoteResult(null)
    setActiveTab('upload')
    ;['duty.nurses','duty.config','duty.result','duty.jobId','duty.elapsed'].forEach(k => localStorage.removeItem(k))
    toast('초기화 완료', 'ok')
  }

  function updateNurse(id: number, patch: Partial<Nurse>) {
    setNurses(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n))
  }

  const grpCount = GROUPS.reduce(
    (acc, g) => ({ ...acc, [g]: nurses.filter(n => n.group === g).length }),
    {} as Record<GroupType, number>
  )
  const totalReqs = nurses.reduce((s, n) => s + n.preferred_requests.length, 0)
  const rankedReqs = nurses.reduce(
    (s, n) => s + n.preferred_requests.filter(r => r.rank).length, 0)
  const noteCount = nurses.filter(n => (n.note ?? '').trim()).length
  const running = status === 'running' || status === 'pending'

  const TABS = [
    { id: 'upload',      label: '업로드',  done: nurses.length > 0 },
    { id: 'nurses',      label: `명단${nurses.length ? ` ${nurses.length}` : ''}`, done: nurses.length > 0 },
    { id: 'constraints', label: '조건',    done: false },
  ] as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: color.bg }}>

      {/* ══ 상단 헤더 ══ */}
      <header style={{
        height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14,
        padding: '0 18px', borderBottom: `1px solid ${color.border}`,
        background: color.bg,
      }}>
        <button onClick={() => setSideOpen(o => !o)} title={sideOpen ? '사이드바 접기' : '사이드바 펼치기'} style={
          button('ghost', { padding: '6px 10px', fontSize: 13 })
        }>
          {sideOpen ? '◀' : '▶'}
        </button>
        <span style={{ fontWeight: 800, fontSize: 15.5, color: color.text, letterSpacing: '-0.2px' }}>
          🏥 간호사 듀티표 생성기
        </span>

        {/* 월 네비게이션 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2, marginLeft: 10,
          background: color.bgMuted, borderRadius: radius.pill, padding: '3px 4px',
        }}>
          <button onClick={() => shiftMonth(-1)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
            color: color.textSecondary, padding: '4px 9px', borderRadius: radius.pill,
          }}>◀</button>
          <span style={{ fontWeight: 800, fontSize: 14, minWidth: 100, textAlign: 'center', color: color.text }}>
            {config.year}년 {config.month}월
          </span>
          <button onClick={() => shiftMonth(1)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
            color: color.textSecondary, padding: '4px 9px', borderRadius: radius.pill,
          }}>▶</button>
        </div>

        {holidays.length > 0 && (
          <span style={{ fontSize: 12, color: color.dangerStrong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            🗓 {holidays.map(h => `${h.day}일 ${h.name}`).join(' · ')}
          </span>
        )}

        <button onClick={handleReset} style={button('ghost', {
          marginLeft: 'auto', padding: '6px 14px', fontSize: 12, whiteSpace: 'nowrap',
        })}>
          ↺ 초기화
        </button>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ══ 사이드바 ══ */}
        <div style={{
          width: sideOpen ? 304 : 0,
          minWidth: sideOpen ? 304 : 0,
          overflow: 'hidden',
          transition: 'width .2s ease, min-width .2s ease',
          borderRight: `1px solid ${color.border}`,
          background: color.bgMuted,
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: '14px 16px 0', flexShrink: 0 }}>
            {/* 세그먼트 탭 (토스 스타일) */}
            <div style={{
              display: 'flex', gap: 2, background: color.bgSubtle,
              borderRadius: radius.md, padding: 3, marginBottom: 14,
            }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                  flex: 1, padding: '7px 4px', border: 'none', borderRadius: radius.sm - 1,
                  background: activeTab === t.id ? color.bg : 'transparent',
                  boxShadow: activeTab === t.id ? '0 1px 3px rgba(15,23,42,0.1)' : 'none',
                  color: activeTab === t.id ? color.text : color.textSecondary,
                  fontSize: 12.5, fontWeight: activeTab === t.id ? 800 : 600, cursor: 'pointer',
                  whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                }}>
                  {t.done && <span style={{ color: color.success, fontSize: 11 }}>✓</span>}
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
            {activeTab === 'upload' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <UploadPanel onParsed={ns => {
                  setNurses(ns)
                  setActiveTab('nurses')
                  toast(`${ns.length}명 · 희망근무 ${ns.reduce((s, n) => s + n.preferred_requests.length, 0)}건 불러옴`, 'ok')
                }} />
                <div style={{ fontSize: 12, color: color.textTertiary, textAlign: 'center' }}>또는</div>
                <button onClick={() => setActiveTab('nurses')} style={button('secondary', {
                  padding: '10px', fontSize: 13,
                })}>
                  ✏️ 직접 명단 입력
                </button>
              </div>
            )}

            {activeTab === 'nurses' && (
              <div>
                {/* 그룹 요약 */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {GROUPS.filter(g => grpCount[g] > 0).map(g => (
                    <span key={g} style={chip(GROUP_COLOR[g] + '1a', GROUP_COLOR[g])}>
                      {GROUP_LABEL[g]} {grpCount[g]}
                    </span>
                  ))}
                  {totalReqs > 0 && (
                    <span style={chip(color.accentBg, color.accentStrong)}>
                      희망 {totalReqs}건
                    </span>
                  )}
                </div>
                {nurses.length > 0 && (
                  <div style={{ fontSize: 11, color: color.textTertiary, marginBottom: 10, lineHeight: 1.5 }}>
                    이름을 클릭하면 희망근무 확인·속성 수정이 가능합니다.
                  </div>
                )}

                {/* 전월 이월 근무 (월경계 연속성) */}
                {nurses.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <PrevMonthUpload nurses={nurses} onMerged={(merged, matched, total) => {
                      setNurses(merged)
                      toast(`전월 근무표 ${total}명 중 ${matched}명 매칭 반영`, matched > 0 ? 'ok' : 'err')
                    }} />
                  </div>
                )}

                {/* 특기사항 해석 진입점 */}
                {noteCount > 0 && (
                  <div style={{
                    marginBottom: 12, padding: '11px 12px', borderRadius: radius.md,
                    background: rankedReqs > 0 ? color.successBg : color.accentBg,
                  }}>
                    <div style={{
                      fontSize: 11.5, fontWeight: 800, marginBottom: 6,
                      color: rankedReqs > 0 ? color.successStrong : color.accentStrong,
                    }}>
                      {rankedReqs > 0
                        ? `✓ 특기사항 반영됨 — 순위 ${rankedReqs}건`
                        : `📝 특기사항 ${noteCount}건 (1순위·주차요일제 등)`}
                    </div>
                    <button onClick={handleInterpretNotes} disabled={noteBusy} style={button('primary', {
                      width: '100%', padding: '8px', fontSize: 12,
                      background: noteBusy ? color.borderStrong : color.accent,
                      cursor: noteBusy ? 'not-allowed' : 'pointer',
                    })}>
                      {noteBusy ? '해석 중...' : rankedReqs > 0 ? '다시 해석' : '특기사항 해석하기'}
                    </button>
                    <details style={{ marginTop: 7 }}>
                      <summary style={{ fontSize: 10.5, color: color.textSecondary, cursor: 'pointer', fontWeight: 600 }}>
                        AI 해석 사용 (선택)
                      </summary>
                      <input type="password" value={apiKey} placeholder="Anthropic API 키 (없으면 규칙 기반)"
                        onChange={e => { setApiKey(e.target.value); saveLS('duty.apiKey', e.target.value) }}
                        style={{
                          width: '100%', marginTop: 6, padding: '6px 8px', borderRadius: radius.sm, fontSize: 11,
                          border: `1px solid ${color.border}`,
                          background: color.bg, color: color.text,
                        }} />
                      <div style={{ fontSize: 10, color: color.textTertiary, marginTop: 5, lineHeight: 1.5 }}>
                        키를 넣으면 오타·특이 표기까지 해석합니다. 비워두면 규칙 기반으로 동작합니다.
                      </div>
                    </details>
                  </div>
                )}

                <NurseAddRow onAdd={n => setNurses([...nurses, n])} nextId={Math.max(0, ...nurses.map(n => n.id)) + 1} />

                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {nurses.map(n => (
                    <NurseRow key={n.id} nurse={n}
                      onUpdate={patch => updateNurse(n.id, patch)}
                      onDelete={() => {
                        if (n.preferred_requests.length > 0 &&
                            !confirm(`${n.name}의 희망근무 ${n.preferred_requests.length}건도 함께 삭제됩니다. 계속할까요?`)) return
                        setNurses(nurses.filter(x => x.id !== n.id))
                      }} />
                  ))}
                  {nurses.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 12, color: color.textTertiary }}>
                      간호사를 추가하거나 엑셀을 업로드해주세요
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'constraints' && (
              <ConstraintPanel config={config} onChange={setConfig} />
            )}
          </div>

          {/* 생성 CTA */}
          <div style={{ padding: 16, borderTop: `1px solid ${color.border}`, flexShrink: 0, background: color.bgMuted }}>
            <SolverProgress status={status} elapsed={elapsed} timeLimit={config.time_limit_seconds} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={handleGenerate} disabled={running} style={button('primary', {
                flex: 1, padding: '13px', fontSize: 14.5,
                background: running ? color.borderStrong : color.accent,
                cursor: running ? 'not-allowed' : 'pointer',
              })}>
                {running ? `실행 중... ${elapsed}s` : nurses.length === 0 ? '✨ 생성 (명단 필요)' : `✨ 듀티표 생성 (${nurses.length}명)`}
              </button>
              {result && (
                <button onClick={handleDownload} title="엑셀 다운로드" style={button('primary', {
                  padding: '13px 15px', fontSize: 13, background: color.success,
                })}>📥</button>
              )}
            </div>
            {status === 'infeasible' && (
              <button onClick={handleAnalyze} disabled={analyzing} style={button('primary', {
                width: '100%', marginTop: 8, padding: '10px', fontSize: 13,
                background: analyzing ? color.borderStrong : color.purple,
                cursor: analyzing ? 'not-allowed' : 'pointer',
              })}>
                {analyzing ? '분석 중... (수 분 소요)' : '🔍 원인 분석'}
              </button>
            )}
          </div>
        </div>

        {/* ══ 메인 영역 ══ */}
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', background: color.bg }}>

          {noteResult && (
            <NoteReviewPanel
              result={noteResult}
              month={config.month}
              applying={noteBusy}
              onApply={handleApplyNotes}
              onCancel={() => setNoteResult(null)}
            />
          )}

          {analysis && (
            <div style={{
              marginBottom: 16, padding: 16, borderRadius: radius.lg,
              background: color.purpleBg,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontWeight: 800, fontSize: 14, color: color.purpleStrong }}>🔍 INFEASIBLE 원인 분석</span>
                <button onClick={() => setAnalysis(null)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: color.purple,
                }}>×</button>
              </div>

              {analysis.culprits?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: color.dangerStrong, marginBottom: 6 }}>❌ 충돌 제약</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {analysis.culprits.map((c: any) => (
                      <div key={c.key} style={{
                        padding: '6px 10px', borderRadius: radius.sm, fontSize: 11,
                        background: color.bg, color: color.dangerStrong,
                      }}>
                        <strong>[{c.label}]</strong> {c.description}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysis.daily_issues?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: color.warningStrong, marginBottom: 6 }}>📅 날짜별 인원 부족</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {analysis.daily_issues.slice(0, 8).map((issue: any, i: number) => (
                      <div key={i} style={{
                        padding: '4px 10px', borderRadius: radius.sm, fontSize: 11,
                        background: color.bg, color: color.warningStrong,
                      }}>{issue.reason}</div>
                    ))}
                    {analysis.daily_issues.length > 8 && (
                      <div style={{ fontSize: 11, color: color.warningStrong }}>… 외 {analysis.daily_issues.length - 8}건</div>
                    )}
                  </div>
                </div>
              )}

              {analysis.summary && (
                <div style={{ fontSize: 11, whiteSpace: 'pre-line', color: color.textSecondary, borderTop: `1px solid ${color.bg}`, paddingTop: 10 }}>
                  {analysis.summary.split('\n').filter((l: string) => l.startsWith('  →')).map((l: string, i: number) => (
                    <div key={i} style={{ padding: '2px 0', color: color.accentStrong }}>{l.trim()}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {result ? (
            <>
              <ResultSummary
                result={result} nurses={nurses} config={config}
                holidays={holidays} elapsed={elapsed} onDownload={handleDownload}
              />

              {/* 필터 · 검색 · 범례 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {['', ...GROUPS].map(g => {
                  const active = filterGrp === g
                  const gc = g ? GROUP_COLOR[g as GroupType] : color.text
                  return (
                    <button key={g} onClick={() => setFilterGrp(g)} style={{
                      padding: '5px 13px', borderRadius: radius.pill, fontSize: 12, fontWeight: 700,
                      border: 'none',
                      background: active ? (g ? gc + '1a' : color.bgSubtle) : 'transparent',
                      color: active ? gc : color.textSecondary,
                      cursor: 'pointer',
                    }}>
                      {g ? GROUP_LABEL[g as GroupType] : '전체'}
                    </button>
                  )
                })}
                <input value={searchName} onChange={e => setSearchName(e.target.value)}
                  placeholder="🔍 이름 검색" style={{
                    padding: '6px 12px', borderRadius: radius.pill, fontSize: 12, width: 120,
                    border: `1px solid ${color.border}`,
                    background: color.bgMuted, color: color.text,
                  }} />

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {(['D','E','N','6D','6N','EDU'] as ShiftType[]).map(s => (
                    <span key={s} style={chip(SHIFT_COLOR[s].bg, SHIFT_COLOR[s].text)}>{s}</span>
                  ))}
                  <span style={{ fontSize: 10, color: color.textTertiary }}>^ 희망반영</span>
                  <span style={{ fontSize: 10, color: color.danger, fontWeight: 700 }}>✕ 희망미반영</span>
                  <span style={{ fontSize: 10, color: color.warning, fontWeight: 700 }}>▣ 프셉터지원일</span>
                  <span style={{ fontSize: 10, color: color.textTertiary }}>★ N전담</span>
                </div>
              </div>

              <ScheduleTable
                result={result}
                nurses={nurses}
                config={config}
                holidays={holidays}
                filterGroup={filterGrp}
                searchName={searchName}
              />
            </>
          ) : status === 'infeasible' && !analysis ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: '40vh', color: color.dangerStrong, textAlign: 'center',
            }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>⛔</div>
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>스케줄 생성 불가</div>
              <div style={{ fontSize: 13, color: color.textSecondary }}>
                현재 설정으로는 조건을 만족하는 듀티표를 만들 수 없습니다.<br/>
                왼쪽 "🔍 원인 분석" 버튼을 눌러 원인을 확인하세요.
              </div>
            </div>
          ) : (
            <EmptyState hasNurses={nurses.length > 0} running={running} />
          )}
        </div>
      </div>

      {/* ══ 토스트 ══ */}
      <div style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', flexDirection: 'column', gap: 8, zIndex: 100, alignItems: 'center',
      }}>
        {toasts.map(t => {
          const meta = TOAST_META[t.kind]
          return (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: '11px 18px', borderRadius: radius.pill, fontSize: 13, fontWeight: 600,
              background: color.dark, color: '#fff',
              boxShadow: '0 12px 32px rgba(15,23,42,0.28)',
              maxWidth: '80vw',
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', background: meta.accent,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 800, flexShrink: 0,
              }}>{meta.icon}</span>
              {t.msg}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── 빈 화면 온보딩 ── */
function EmptyState({ hasNurses, running }: { hasNurses: boolean; running: boolean }) {
  const steps = [
    { icon: '📂', title: '1. 희망근무 업로드', desc: '병동 희망근무 엑셀을 그대로 올리면 명단·그룹·희망이 자동 인식됩니다', done: hasNurses },
    { icon: '👥', title: '2. 명단 확인', desc: '그룹·N전담·프리셉터가 맞게 읽혔는지 확인하고 필요하면 수정하세요', done: false },
    { icon: '✨', title: '3. 생성 & 검토', desc: '약 90초 내에 완성 — 반영률·리메인·미달 여부를 한눈에 확인 후 엑셀로 다운로드', done: false },
  ]
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '70vh', textAlign: 'center',
    }}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>{running ? '⏳' : '🏥'}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6, color: color.text, letterSpacing: '-0.3px' }}>
        {running ? '듀티표를 만들고 있습니다...' : '간호사 듀티표 생성기'}
      </div>
      {!running && (
        <>
          <div style={{ fontSize: 13, color: color.textSecondary, marginBottom: 28 }}>
            세 단계면 한 달 듀티표가 완성됩니다
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 760 }}>
            {steps.map(s => (
              <div key={s.title} style={{
                width: 220, padding: '20px 18px', borderRadius: radius.lg, textAlign: 'left',
                background: s.done ? color.successBg : color.bgMuted,
                border: `1px solid ${s.done ? color.successBg : color.border}`,
              }}>
                <div style={{ fontSize: 24, marginBottom: 10 }}>{s.done ? '✅' : s.icon}</div>
                <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 5, color: color.text }}>{s.title}</div>
                <div style={{ fontSize: 12, color: color.textSecondary, lineHeight: 1.55 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* ── 간호사 행 (펼침 상세 + 인라인 수정) ── */
function NurseRow({ nurse: n, onUpdate, onDelete }: {
  nurse: Nurse
  onUpdate: (patch: Partial<Nurse>) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const fixedDays = Object.entries(n.fixed_requests)

  return (
    <div style={{
      borderRadius: radius.md, fontSize: 12,
      background: color.bg,
      border: `1px solid ${color.border}`,
    }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 11px', cursor: 'pointer',
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: GROUP_COLOR[n.group], flexShrink: 0 }} />
        <span style={{ flex: 1, fontWeight: 700, color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
        {n.preferred_requests.length > 0 && (
          <span style={{ fontSize: 10, color: color.accentStrong, fontWeight: 700 }}>희망{n.preferred_requests.length}</span>
        )}
        {n.is_night_dedicated && <span style={chip(color.purpleBg, color.purpleStrong)}>N전담</span>}
        {n.can_two_shift && <span style={chip(color.accentBg, color.accentStrong)}>2교대</span>}
        {n.is_part_time && <span style={chip(color.warningBg, color.warningStrong)}>주2일</span>}
        {n.is_preceptee && n.preceptor_subgroup && (
          <span style={chip('#ffeff5', '#d6336c')}>프리셉티{n.preceptor_subgroup}</span>
        )}
        {!n.is_preceptee && n.preceptor_subgroup && (
          <span style={chip(color.purpleBg, color.purple)}>프리셉터{n.preceptor_subgroup}</span>
        )}
        <span style={{ fontSize: 10, color: color.textTertiary }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '9px 11px', borderTop: `1px solid ${color.border}` }}>
          {/* 속성 편집 */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <select value={n.group} onChange={e => onUpdate({ group: e.target.value as GroupType })} style={{
              padding: '4px 5px', borderRadius: radius.sm - 2, fontSize: 11,
              border: `1px solid ${color.border}`,
              background: color.bgMuted, color: color.text,
            }}>
              {GROUPS.map(g => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
            </select>
            {([
              ['is_night_dedicated', 'N전담'],
              ['can_two_shift',      '2교대'],
              ['is_part_time',       '주2일'],
            ] as [keyof Nurse, string][]).map(([key, lbl]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', color: color.textSecondary }}>
                <input type="checkbox" checked={!!n[key]} style={{ accentColor: color.accent }}
                  onChange={e => onUpdate({ [key]: e.target.checked } as Partial<Nurse>)} />
                {lbl}
              </label>
            ))}
            <button onClick={onDelete} style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              color: color.danger, cursor: 'pointer', fontSize: 11, fontWeight: 700,
            }}>삭제</button>
          </div>

          {n.sabun && (
            <div style={{ fontSize: 10, color: color.textTertiary, marginBottom: 6 }}>
              사번 {n.sabun}{n.career_years != null ? ` · ${n.career_years}년차` : ''}
            </div>
          )}

          {/* 희망근무 미리보기 */}
          {(n.preferred_requests.length > 0 || fixedDays.length > 0) ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {fixedDays.map(([d, s]) => (
                <span key={`f${d}`} title="고정 (교육 등)"
                  style={chip(SHIFT_COLOR[s]?.bg ?? color.bgSubtle, SHIFT_COLOR[s]?.text ?? color.textSecondary,
                    { border: '1px dashed currentColor' })}>
                  {d}일 {s}
                </span>
              ))}
              {[...n.preferred_requests].sort((a, b) => a.day - b.day).map((r, i) => {
                const rankBorder = r.rank === 1 ? color.dangerStrong
                                 : r.rank === 2 ? color.warningStrong
                                 : r.rank === 3 ? color.accentStrong : undefined
                return (
                  <span key={i} title={r.rank ? `${r.rank}순위` : undefined}
                    style={chip(
                      SHIFT_COLOR[r.shift]?.bg === 'transparent' ? color.bgSubtle : SHIFT_COLOR[r.shift]?.bg,
                      SHIFT_COLOR[r.shift]?.text,
                      rankBorder ? { boxShadow: `0 0 0 1.5px ${rankBorder}` } : undefined,
                    )}>
                    {r.day}일 {r.shift === 'O' ? '오프' : r.shift}
                    {r.rank ? <sup style={{ fontSize: 8 }}>{r.rank}</sup> : null}
                  </span>
                )
              })}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: color.textTertiary }}>희망근무 없음</div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── 간호사 추가 인풋 행 ── */
function NurseAddRow({ onAdd, nextId }: { onAdd: (n: Nurse) => void; nextId: number }) {
  const [name,  setName]  = useState('')
  const [group, setGroup] = useState<GroupType>('mid')
  const [nd,    setNd]    = useState(false)
  const [ts,    setTs]    = useState(false)
  const [pt,    setPt]    = useState(false)

  function add() {
    if (!name.trim()) return
    onAdd({
      id: nextId,
      name: name.trim(),
      group,
      is_night_dedicated: nd,
      can_two_shift: ts,
      is_part_time: pt,
      fixed_requests: {},
      preferred_requests: [],
      preceptor_subgroup: null,
      is_preceptee: false,
      preceptor_support_days: 0,
      no_night: false,
      independence_day: null,
      weekly_fixed_off: [],
      prev_tail: {},
      career_years: null,
      sabun: '',
      work_kind: '',
      note: '',
    })
    setName(''); setNd(false); setTs(false); setPt(false)
  }

  const inputStyle: React.CSSProperties = {
    padding: '7px 9px', borderRadius: radius.sm, fontSize: 12,
    border: `1px solid ${color.border}`,
    background: color.bgMuted, color: color.text,
  }

  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
      <input value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && add()}
        placeholder="이름" style={{ ...inputStyle, flex: 1, minWidth: 70 }} />
      <select value={group} onChange={e => setGroup(e.target.value as GroupType)} style={{ ...inputStyle, padding: '7px 4px' }}>
        {GROUPS.map(g => (
          <option key={g} value={g}>{GROUP_LABEL[g]}</option>
        ))}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', color: color.textSecondary }}>
        <input type="checkbox" checked={nd} onChange={e => setNd(e.target.checked)} style={{ accentColor: color.accent }} />N전담
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', color: color.textSecondary }}>
        <input type="checkbox" checked={ts} onChange={e => setTs(e.target.checked)} style={{ accentColor: color.accent }} />2교대
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', color: color.textSecondary }}>
        <input type="checkbox" checked={pt} onChange={e => setPt(e.target.checked)} style={{ accentColor: color.accent }} />주2일
      </label>
      <button onClick={add} style={button('primary', { padding: '7px 14px', fontSize: 12 })}>추가</button>
    </div>
  )
}
