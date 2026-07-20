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
import UploadPanel from '../components/UploadPanel'
import ConstraintPanel from '../components/ConstraintPanel'
import SolverProgress from '../components/SolverProgress'
import ScheduleTable from '../components/ScheduleTable'
import ResultSummary from '../components/ResultSummary'
import NoteReviewPanel from '../components/NoteReviewPanel'

const DEFAULT_CONFIG: ConstraintConfig = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  min_staff_weekday:  { D: 7, E: 6, N: 6 },
  min_staff_saturday: { D: 6, E: 5, N: 5 },
  min_staff_sunday:   { D: 5, E: 5, N: 5 },
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

// ─── 토스트 ──────────────────────────────────────────────────────────────────

interface Toast { id: number; msg: string; kind: 'ok' | 'err' | 'info' }

export default function Dashboard() {
  const [nurses,   setNurses]   = useState<Nurse[]>(() => loadLS('duty.nurses', []))
  const [config,   setConfig]   = useState<ConstraintConfig>(() => ({ ...DEFAULT_CONFIG, ...loadLS('duty.config', {}) }))
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
    { id: 'upload',      label: '① 업로드',  done: nurses.length > 0 },
    { id: 'nurses',      label: `② 명단${nurses.length ? ` (${nurses.length})` : ''}`, done: nurses.length > 0 },
    { id: 'constraints', label: '③ 조건',    done: false },
  ] as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      {/* ══ 상단 헤더 ══ */}
      <header style={{
        height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14,
        padding: '0 16px', borderBottom: '0.5px solid var(--color-border-secondary)',
        background: 'var(--color-background-primary)',
      }}>
        <button onClick={() => setSideOpen(o => !o)} title={sideOpen ? '사이드바 접기' : '사이드바 펼치기'} style={{
          background: 'none', border: '0.5px solid var(--color-border-secondary)',
          borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 13,
          color: 'var(--color-text-secondary)',
        }}>
          {sideOpen ? '◀' : '▶'}
        </button>
        <span style={{ fontWeight: 700, fontSize: 15 }}>🏥 간호사 듀티표 생성기</span>

        {/* 월 네비게이션 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 10 }}>
          <button onClick={() => shiftMonth(-1)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
            color: 'var(--color-text-secondary)', padding: '2px 6px',
          }}>◀</button>
          <span style={{ fontWeight: 700, fontSize: 15, minWidth: 110, textAlign: 'center' }}>
            {config.year}년 {config.month}월
          </span>
          <button onClick={() => shiftMonth(1)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
            color: 'var(--color-text-secondary)', padding: '2px 6px',
          }}>▶</button>
        </div>

        {holidays.length > 0 && (
          <span style={{ fontSize: 12, color: '#dc2626', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            🗓 {holidays.map(h => `${h.day}일 ${h.name}`).join(' · ')}
          </span>
        )}

        <button onClick={handleReset} style={{
          marginLeft: 'auto', background: 'none',
          border: '0.5px solid var(--color-border-secondary)', borderRadius: 6,
          padding: '5px 12px', cursor: 'pointer', fontSize: 12,
          color: 'var(--color-text-secondary)', whiteSpace: 'nowrap',
        }}>
          ↺ 초기화
        </button>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ══ 사이드바 ══ */}
        <div style={{
          width: sideOpen ? 300 : 0,
          minWidth: sideOpen ? 300 : 0,
          overflow: 'hidden',
          transition: 'all .2s ease',
          borderRight: '0.5px solid var(--color-border-tertiary)',
          background: 'var(--color-background-primary)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 0, borderBottom: '0.5px solid var(--color-border-tertiary)', marginBottom: 12 }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                  flex: 1, padding: '8px 2px', background: 'none', border: 'none',
                  borderBottom: activeTab === t.id ? '2px solid #2563eb' : '2px solid transparent',
                  color: activeTab === t.id ? '#2563eb' : t.done ? '#059669' : 'var(--color-text-secondary)',
                  fontSize: 12, fontWeight: activeTab === t.id ? 700 : 500, cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}>
                  {t.done ? '✓ ' : ''}{t.label}
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
                  toast(`${ns.length}명 · 희망근무 ${ns.reduce((s, n) => s + n.preferred_requests.length, 0)}건 불러옴 — 명단을 확인하세요`, 'ok')
                }} />
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center' }}>또는</div>
                <button onClick={() => setActiveTab('nurses')} style={{
                  padding: '10px', background: 'var(--color-background-secondary)',
                  border: '0.5px solid var(--color-border-secondary)', borderRadius: 8,
                  fontSize: 13, cursor: 'pointer', color: 'var(--color-text-primary)',
                }}>
                  ✏️ 직접 명단 입력
                </button>
              </div>
            )}

            {activeTab === 'nurses' && (
              <div>
                {/* 그룹 요약 */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {GROUPS.filter(g => grpCount[g] > 0).map(g => (
                    <span key={g} style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      background: GROUP_COLOR[g] + '22', color: GROUP_COLOR[g],
                      border: `1px solid ${GROUP_COLOR[g]}44`, fontWeight: 600,
                    }}>
                      {GROUP_LABEL[g]} {grpCount[g]}
                    </span>
                  ))}
                  {totalReqs > 0 && (
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', fontWeight: 600,
                    }}>
                      희망 {totalReqs}건
                    </span>
                  )}
                </div>
                {nurses.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
                    이름을 클릭하면 희망근무 확인·속성 수정이 가능합니다.
                  </div>
                )}

                {/* 특기사항 해석 진입점 */}
                {noteCount > 0 && (
                  <div style={{
                    marginBottom: 10, padding: '9px 11px', borderRadius: 8,
                    background: rankedReqs > 0 ? '#f0fdf4' : '#eef2ff',
                    border: `1px solid ${rankedReqs > 0 ? '#bbf7d0' : '#c7d2fe'}`,
                  }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, marginBottom: 5,
                      color: rankedReqs > 0 ? '#166534' : '#3730a3',
                    }}>
                      {rankedReqs > 0
                        ? `✓ 특기사항 반영됨 — 순위 ${rankedReqs}건`
                        : `📝 특기사항 ${noteCount}건 (1순위·주차요일제 등)`}
                    </div>
                    <button onClick={handleInterpretNotes} disabled={noteBusy} style={{
                      width: '100%', padding: '7px', borderRadius: 6, border: 'none',
                      fontSize: 12, fontWeight: 600, color: '#fff',
                      background: noteBusy ? '#94a3b8' : '#4f46e5',
                      cursor: noteBusy ? 'not-allowed' : 'pointer',
                    }}>
                      {noteBusy ? '해석 중...' : rankedReqs > 0 ? '다시 해석' : '특기사항 해석하기'}
                    </button>
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ fontSize: 10, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
                        AI 해석 사용 (선택)
                      </summary>
                      <input type="password" value={apiKey} placeholder="Anthropic API 키 (없으면 규칙 기반)"
                        onChange={e => { setApiKey(e.target.value); saveLS('duty.apiKey', e.target.value) }}
                        style={{
                          width: '100%', marginTop: 5, padding: '5px 7px', borderRadius: 5, fontSize: 11,
                          border: '0.5px solid var(--color-border-secondary)',
                          background: 'var(--color-background-primary)',
                          color: 'var(--color-text-primary)',
                        }} />
                      <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
                        키를 넣으면 오타·특이 표기까지 해석합니다. 비워두면 규칙 기반으로 동작합니다.
                      </div>
                    </details>
                  </div>
                )}

                <NurseAddRow onAdd={n => setNurses([...nurses, n])} nextId={Math.max(0, ...nurses.map(n => n.id)) + 1} />

                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                    <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>
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
          <div style={{ padding: 16, borderTop: '0.5px solid var(--color-border-tertiary)', flexShrink: 0 }}>
            <SolverProgress status={status} elapsed={elapsed} timeLimit={config.time_limit_seconds} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={handleGenerate} disabled={running} style={{
                flex: 1, padding: '11px', background: running ? '#94a3b8' : '#1e293b',
                color: '#fff', border: 'none', borderRadius: 8, fontSize: 14,
                fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer',
              }}>
                {running ? `실행 중... ${elapsed}s` : nurses.length === 0 ? '✨ 생성 (명단 필요)' : `✨ 듀티표 생성 (${nurses.length}명)`}
              </button>
              {result && (
                <button onClick={handleDownload} title="엑셀 다운로드" style={{
                  padding: '11px 14px', background: '#059669', color: '#fff',
                  border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                }}>📥</button>
              )}
            </div>
            {status === 'infeasible' && (
              <button onClick={handleAnalyze} disabled={analyzing} style={{
                width: '100%', marginTop: 8, padding: '9px', background: analyzing ? '#94a3b8' : '#7c3aed',
                color: '#fff', border: 'none', borderRadius: 8, fontSize: 13,
                fontWeight: 600, cursor: analyzing ? 'not-allowed' : 'pointer',
              }}>
                {analyzing ? '분석 중... (수 분 소요)' : '🔍 원인 분석'}
              </button>
            )}
          </div>
        </div>

        {/* ══ 메인 영역 ══ */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

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
              marginBottom: 16, padding: 16, borderRadius: 10,
              border: '1px solid #7c3aed44', background: '#f5f3ff',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#5b21b6' }}>🔍 INFEASIBLE 원인 분석</span>
                <button onClick={() => setAnalysis(null)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#7c3aed',
                }}>×</button>
              </div>

              {analysis.culprits?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#991b1b', marginBottom: 6 }}>❌ 충돌 제약</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {analysis.culprits.map((c: any) => (
                      <div key={c.key} style={{
                        padding: '5px 10px', borderRadius: 6, fontSize: 11,
                        background: '#fee2e2', color: '#991b1b',
                        border: '1px solid #fca5a5',
                      }}>
                        <strong>[{c.label}]</strong> {c.description}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {analysis.daily_issues?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#92400e', marginBottom: 6 }}>📅 날짜별 인원 부족</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {analysis.daily_issues.slice(0, 8).map((issue: any, i: number) => (
                      <div key={i} style={{
                        padding: '3px 10px', borderRadius: 4, fontSize: 11,
                        background: '#fef3c7', color: '#92400e',
                      }}>{issue.reason}</div>
                    ))}
                    {analysis.daily_issues.length > 8 && (
                      <div style={{ fontSize: 11, color: '#92400e' }}>… 외 {analysis.daily_issues.length - 8}건</div>
                    )}
                  </div>
                </div>
              )}

              {analysis.summary && (
                <div style={{ fontSize: 11, whiteSpace: 'pre-line', color: '#374151', borderTop: '1px solid #ddd6fe', paddingTop: 10 }}>
                  {analysis.summary.split('\n').filter((l: string) => l.startsWith('  →')).map((l: string, i: number) => (
                    <div key={i} style={{ padding: '2px 0', color: '#1d4ed8' }}>{l.trim()}</div>
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
                {['', ...GROUPS].map(g => (
                  <button key={g} onClick={() => setFilterGrp(g)} style={{
                    padding: '4px 12px', borderRadius: 14, fontSize: 12, fontWeight: 500,
                    border: `0.5px solid ${filterGrp===g ? (g ? GROUP_COLOR[g as GroupType] : '#1e293b') : 'var(--color-border-secondary)'}`,
                    background: filterGrp===g ? (g ? GROUP_COLOR[g as GroupType]+'22' : '#f1f5f9') : 'transparent',
                    color: filterGrp===g ? (g ? GROUP_COLOR[g as GroupType] : '#1e293b') : 'var(--color-text-secondary)',
                    cursor: 'pointer',
                  }}>
                    {g ? GROUP_LABEL[g as GroupType] : '전체'}
                  </button>
                ))}
                <input value={searchName} onChange={e => setSearchName(e.target.value)}
                  placeholder="🔍 이름 검색" style={{
                    padding: '5px 10px', borderRadius: 14, fontSize: 12, width: 120,
                    border: '0.5px solid var(--color-border-secondary)',
                    background: 'var(--color-background-primary)',
                    color: 'var(--color-text-primary)',
                  }} />

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {(['D','E','N','6D','6N','EDU'] as ShiftType[]).map(s => (
                    <span key={s} style={{
                      fontSize: 10, padding: '2px 7px', borderRadius: 4, fontWeight: 700,
                      background: SHIFT_COLOR[s].bg, color: SHIFT_COLOR[s].text,
                    }}>{s}</span>
                  ))}
                  <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>^ 희망반영</span>
                  <span style={{ fontSize: 10, color: '#dc2626', fontWeight: 700 }}>✕ 희망미반영</span>
                  <span style={{ fontSize: 10, color: '#f97316', fontWeight: 700 }}>▣ 프셉터지원일</span>
                  <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>★ N전담</span>
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
              height: '40vh', color: '#991b1b', textAlign: 'center',
            }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>⛔</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>스케줄 생성 불가</div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
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
        {toasts.map(t => (
          <div key={t.id} style={{
            padding: '10px 18px', borderRadius: 10, fontSize: 13, fontWeight: 500,
            background: t.kind === 'ok' ? '#065f46' : t.kind === 'err' ? '#991b1b' : '#1e293b',
            color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            maxWidth: '80vw',
          }}>
            {t.msg}
          </div>
        ))}
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
      <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 6, color: 'var(--color-text-primary)' }}>
        {running ? '듀티표를 만들고 있습니다...' : '간호사 듀티표 생성기'}
      </div>
      {!running && (
        <>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 28 }}>
            세 단계면 한 달 듀티표가 완성됩니다
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 760 }}>
            {steps.map(s => (
              <div key={s.title} style={{
                width: 220, padding: '18px 16px', borderRadius: 12, textAlign: 'left',
                background: 'var(--color-background-primary)',
                border: `1px solid ${s.done ? '#a7f3d0' : 'var(--color-border-secondary)'}`,
              }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>{s.done ? '✅' : s.icon}</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{s.title}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{s.desc}</div>
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
      borderRadius: 6, fontSize: 12,
      background: 'var(--color-background-secondary)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', cursor: 'pointer',
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: GROUP_COLOR[n.group], flexShrink: 0 }} />
        <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
        {n.preferred_requests.length > 0 && (
          <span style={{ fontSize: 10, color: '#1d4ed8', fontWeight: 600 }}>희망{n.preferred_requests.length}</span>
        )}
        {n.is_night_dedicated && (
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#4c1d95', color: '#fff', fontWeight: 600 }}>N전담</span>
        )}
        {n.can_two_shift && (
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#1e3a8a', color: '#fff', fontWeight: 600 }}>2교대</span>
        )}
        {n.is_part_time && (
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#92400e', color: '#fff', fontWeight: 600 }}>주2일</span>
        )}
        {n.is_preceptee && n.preceptor_subgroup && (
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#db2777', color: '#fff', fontWeight: 600 }}>프리셉티{n.preceptor_subgroup}</span>
        )}
        {!n.is_preceptee && n.preceptor_subgroup && (
          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: '#9333ea', color: '#fff', fontWeight: 600 }}>프리셉터{n.preceptor_subgroup}</span>
        )}
        <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--color-border-tertiary)' }}>
          {/* 속성 편집 */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <select value={n.group} onChange={e => onUpdate({ group: e.target.value as GroupType })} style={{
              padding: '3px 4px', borderRadius: 5, fontSize: 11,
              border: '0.5px solid var(--color-border-secondary)',
              background: 'var(--color-background-primary)',
              color: 'var(--color-text-primary)',
            }}>
              {GROUPS.map(g => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
            </select>
            {([
              ['is_night_dedicated', 'N전담'],
              ['can_two_shift',      '2교대'],
              ['is_part_time',       '주2일'],
            ] as [keyof Nurse, string][]).map(([key, lbl]) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!n[key]}
                  onChange={e => onUpdate({ [key]: e.target.checked } as Partial<Nurse>)} />
                {lbl}
              </label>
            ))}
            <button onClick={onDelete} style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              color: '#ef4444', cursor: 'pointer', fontSize: 11, fontWeight: 600,
            }}>삭제</button>
          </div>

          {n.sabun && (
            <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
              사번 {n.sabun}{n.career_years != null ? ` · ${n.career_years}년차` : ''}
            </div>
          )}

          {/* 희망근무 미리보기 */}
          {(n.preferred_requests.length > 0 || fixedDays.length > 0) ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
              {fixedDays.map(([d, s]) => (
                <span key={`f${d}`} title="고정 (교육 등)" style={{
                  fontSize: 10, padding: '1px 5px', borderRadius: 4, fontWeight: 700,
                  background: SHIFT_COLOR[s]?.bg ?? '#eee', color: SHIFT_COLOR[s]?.text ?? '#333',
                  border: '1px dashed currentColor',
                }}>{d}일 {s}</span>
              ))}
              {[...n.preferred_requests].sort((a, b) => a.day - b.day).map((r, i) => (
                <span key={i} title={r.rank ? `${r.rank}순위` : undefined} style={{
                  fontSize: 10, padding: '1px 5px', borderRadius: 4, fontWeight: 600,
                  background: SHIFT_COLOR[r.shift]?.bg === 'transparent' ? '#f1f5f9' : SHIFT_COLOR[r.shift]?.bg,
                  color: SHIFT_COLOR[r.shift]?.text,
                  outline: r.rank === 1 ? '1.5px solid #dc2626'
                         : r.rank === 2 ? '1.5px solid #ea580c'
                         : r.rank === 3 ? '1.5px solid #ca8a04' : undefined,
                }}>
                  {r.day}일 {r.shift === 'O' ? '오프' : r.shift}
                  {r.rank ? <sup style={{ fontSize: 8 }}>{r.rank}</sup> : null}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>희망근무 없음</div>
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
      career_years: null,
      sabun: '',
      work_kind: '',
      note: '',
    })
    setName(''); setNd(false); setTs(false); setPt(false)
  }

  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
      <input value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && add()}
        placeholder="이름" style={{
          flex: 1, minWidth: 70, padding: '6px 8px', borderRadius: 6, fontSize: 12,
          border: '0.5px solid var(--color-border-secondary)',
          background: 'var(--color-background-primary)',
          color: 'var(--color-text-primary)',
        }} />
      <select value={group} onChange={e => setGroup(e.target.value as GroupType)} style={{
        padding: '6px 4px', borderRadius: 6, fontSize: 11,
        border: '0.5px solid var(--color-border-secondary)',
        background: 'var(--color-background-primary)',
        color: 'var(--color-text-primary)',
      }}>
        {GROUPS.map(g => (
          <option key={g} value={g}>{GROUP_LABEL[g]}</option>
        ))}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <input type="checkbox" checked={nd} onChange={e => setNd(e.target.checked)} />N전담
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <input type="checkbox" checked={ts} onChange={e => setTs(e.target.checked)} />2교대
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <input type="checkbox" checked={pt} onChange={e => setPt(e.target.checked)} />주2일
      </label>
      <button onClick={add} style={{
        padding: '6px 12px', background: '#2563eb', color: '#fff',
        border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
      }}>추가</button>
    </div>
  )
}
