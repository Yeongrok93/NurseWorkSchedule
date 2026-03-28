import { useEffect, useRef, useState } from 'react'
import type { Nurse, ConstraintConfig, ScheduleResult, Holiday, SolverStatus, GroupType } from '../types'
import { GROUP_LABEL, GROUP_COLOR } from '../types'
import { startSchedule, connectJobWS, downloadExcel, getHolidays } from '../utils/api'
import UploadPanel from '../components/UploadPanel'
import ConstraintPanel from '../components/ConstraintPanel'
import SolverProgress from '../components/SolverProgress'
import ScheduleTable from '../components/ScheduleTable'

const DEFAULT_CONFIG: ConstraintConfig = {
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  min_staff_weekday:  { D: 7, E: 6, N: 6 },
  min_staff_saturday: { D: 6, E: 5, N: 5 },
  min_staff_sunday:   { D: 5, E: 5, N: 5 },
  max_consecutive_work: 5,
  night_dedicated_count: 14,
  max_first_year: 12,
  min_night_block: 2,
  max_night_block: 3,
  time_limit_seconds: 90,
}

const GROUPS: GroupType[] = ['leader', 'mid', 'junior', 'first']

export default function Dashboard() {
  const [nurses,   setNurses]   = useState<Nurse[]>([])
  const [config,   setConfig]   = useState<ConstraintConfig>(DEFAULT_CONFIG)
  const [result,   setResult]   = useState<ScheduleResult | null>(null)
  const [jobId,    setJobId]    = useState<string | null>(null)
  const [status,   setStatus]   = useState<SolverStatus>('idle')
  const [elapsed,  setElapsed]  = useState(0)
  const [holidays, setHols]     = useState<Holiday[]>([])
  const [filterGrp, setFilterGrp] = useState('')
  const [sideOpen, setSideOpen] = useState(true)
  const [activeTab, setActiveTab] = useState<'upload'|'nurses'|'constraints'>('upload')

  const wsRef    = useRef<WebSocket | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    getHolidays(config.year, config.month).then(setHols).catch(() => {})
  }, [config.year, config.month])

  function clearTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }

  async function handleGenerate() {
    if (nurses.length === 0) { alert('간호사 명단을 먼저 입력해주세요'); return }
    setStatus('pending'); setElapsed(0); setResult(null)
    const start = Date.now()
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500)
    try {
      const id = await startSchedule(nurses, config)
      setJobId(id)
      wsRef.current?.close()
      wsRef.current = connectJobWS(
        id,
        s  => setStatus(s as SolverStatus),
        r  => { setResult(r); setStatus('done'); clearTimer() },
        () => { setStatus('error'); clearTimer() },
      )
    } catch {
      setStatus('error'); clearTimer()
    }
  }

  function handleDownload() {
    if (!jobId) return
    downloadExcel(jobId, nurses, config).catch(() => alert('다운로드 실패'))
  }

  const grpCount = GROUPS.reduce((acc, g) => ({ ...acc, [g]: nurses.filter(n => n.group === g).length }), {} as Record<GroupType, number>)
  const running = status === 'running' || status === 'pending'

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* ── 사이드바 ── */}
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
        <div style={{ padding: '16px 16px 0', flexShrink: 0 }}>
          {/* 탭 */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '0.5px solid var(--color-border-tertiary)', marginBottom: 16 }}>
            {([
              { id: 'upload',      label: '업로드' },
              { id: 'nurses',      label: '명단' },
              { id: 'constraints', label: '설정' },
            ] as const).map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                flex: 1, padding: '8px 4px', background: 'none', border: 'none',
                borderBottom: activeTab === t.id ? '2px solid #2563eb' : '2px solid transparent',
                color: activeTab === t.id ? '#2563eb' : 'var(--color-text-secondary)',
                fontSize: 12, fontWeight: activeTab === t.id ? 600 : 400, cursor: 'pointer',
              }}>{t.label}</button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          {activeTab === 'upload' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <UploadPanel onParsed={nurses => { setNurses(nurses); setActiveTab('nurses') }} />
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
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {GROUPS.map(g => (
                  <span key={g} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10,
                    background: GROUP_COLOR[g] + '22', color: GROUP_COLOR[g],
                    border: `1px solid ${GROUP_COLOR[g]}44`, fontWeight: 600,
                  }}>
                    {GROUP_LABEL[g]} {grpCount[g]}
                  </span>
                ))}
              </div>

              {/* 수동 추가 인풋 */}
              <NurseAddRow onAdd={n => setNurses([...nurses, n])} nextId={nurses.length + 1} />

              {/* 명단 */}
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {nurses.map(n => (
                  <div key={n.id} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 10px', borderRadius: 6, fontSize: 12,
                    background: 'var(--color-background-secondary)',
                    border: '0.5px solid var(--color-border-tertiary)',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: GROUP_COLOR[n.group], flexShrink: 0 }} />
                    <span style={{ flex: 1, fontWeight: 500 }}>{n.is_night_dedicated ? '★ ' : ''}{n.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{GROUP_LABEL[n.group].slice(0,2)}</span>
                    <button onClick={() => setNurses(nurses.filter(x => x.id !== n.id))}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
                  </div>
                ))}
                {nurses.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    간호사를 추가해주세요
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'constraints' && (
            <ConstraintPanel config={config} onChange={setConfig} />
          )}
        </div>

        {/* 생성 버튼 */}
        <div style={{ padding: 16, borderTop: '0.5px solid var(--color-border-tertiary)', flexShrink: 0 }}>
          <SolverProgress status={status} elapsed={elapsed} timeLimit={config.time_limit_seconds} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={handleGenerate} disabled={running} style={{
              flex: 1, padding: '10px', background: running ? '#94a3b8' : '#1e293b',
              color: '#fff', border: 'none', borderRadius: 8, fontSize: 14,
              fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer',
            }}>
              {running ? '실행 중...' : '✨ 생성'}
            </button>
            {result && (
              <button onClick={handleDownload} style={{
                padding: '10px 14px', background: '#059669', color: '#fff',
                border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              }}>📥</button>
            )}
          </div>
        </div>
      </div>

      {/* ── 메인 영역 ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {/* 상단 바 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button onClick={() => setSideOpen(o => !o)} style={{
            background: 'none', border: '0.5px solid var(--color-border-secondary)',
            borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 13,
            color: 'var(--color-text-secondary)',
          }}>
            {sideOpen ? '◀' : '▶'}
          </button>
          <span style={{ fontWeight: 700, fontSize: 16 }}>{config.year}년 {config.month}월</span>
          {holidays.length > 0 && (
            <span style={{ fontSize: 12, color: '#dc2626' }}>
              🗓 공휴일: {holidays.map(h => `${h.day}일 ${h.name}`).join(' · ')}
            </span>
          )}

          {result && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {/* 그룹 필터 */}
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
            </div>
          )}
        </div>

        {result ? (
          <ScheduleTable
            result={result}
            nurses={nurses}
            config={config}
            holidays={holidays}
            filterGroup={filterGrp}
          />
        ) : (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '60vh', color: 'var(--color-text-secondary)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 56, marginBottom: 20 }}>🏥</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: 'var(--color-text-primary)' }}>
              간호사 듀티표 생성기
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              왼쪽 사이드바에서 간호사 명단을 입력하고<br/>
              "✨ 생성" 버튼을 눌러주세요
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── 간호사 추가 인풋 행 ── */
function NurseAddRow({ onAdd, nextId }: { onAdd: (n: Nurse) => void; nextId: number }) {
  const [name,  setName]  = useState('')
  const [group, setGroup] = useState<GroupType>('mid')
  const [nd,    setNd]    = useState(false)

  function add() {
    if (!name.trim()) return
    onAdd({ id: nextId, name: name.trim(), group, is_night_dedicated: nd, fixed_requests: {}, preferred_requests: [] })
    setName(''); setNd(false)
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
        {(['leader','mid','junior','first'] as GroupType[]).map(g => (
          <option key={g} value={g}>{GROUP_LABEL[g]}</option>
        ))}
      </select>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <input type="checkbox" checked={nd} onChange={e => setNd(e.target.checked)} />N전담
      </label>
      <button onClick={add} style={{
        padding: '6px 12px', background: '#2563eb', color: '#fff',
        border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600,
      }}>추가</button>
    </div>
  )
}
