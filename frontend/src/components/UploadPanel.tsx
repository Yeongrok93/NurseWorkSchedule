import { useRef, useState } from 'react'
import type { Nurse, GroupType } from '../types'
import { GROUP_LABEL, GROUP_COLOR } from '../types'
import { parseExcel } from '../utils/api'
import { color, radius, chip, button } from '../theme'

interface Props {
  onParsed: (nurses: Nurse[]) => void
}

const GROUPS: GroupType[] = ['charge', 'leader', 'mid', 'junior', 'first']

export default function UploadPanel({ onParsed }: Props) {
  const fileRef  = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle'|'loading'|'preview'|'err'>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState('')
  const [parsed,  setParsed]  = useState<Nurse[] | null>(null)

  async function process(file: File) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setState('err'); setErrMsg('xlsx 또는 xls 파일만 허용됩니다'); return
    }
    setState('loading'); setErrMsg(''); setFileName(file.name)
    try {
      const { nurses } = await parseExcel(file)
      setParsed(nurses)
      setState('preview')
    } catch (e: any) {
      setState('err'); setErrMsg(e.message ?? '파싱 오류')
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) process(f)
    e.target.value = ''
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) process(f)
  }

  function reset() {
    setState('idle'); setParsed(null); setFileName(''); setErrMsg('')
  }

  // ── 파싱 확인 단계 (Airtable 임포트 미리보기 패턴) ──
  if (state === 'preview' && parsed) {
    const grpCount = GROUPS.reduce(
      (acc, g) => ({ ...acc, [g]: parsed.filter(n => n.group === g).length }),
      {} as Record<GroupType, number>
    )
    const reqCount = parsed.reduce((s, n) => s + n.preferred_requests.length, 0)
    const noteCount = parsed.filter(n => (n.note ?? '').trim()).length
    const unknownGroup = parsed.filter(n => !GROUPS.includes(n.group)).length

    return (
      <div style={{
        border: `1px solid ${color.border}`, borderRadius: radius.lg,
        background: color.bg, overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px 12px', borderBottom: `1px solid ${color.border}` }}>
          <div style={{ fontSize: 12, color: color.textSecondary, marginBottom: 2 }}>파싱 완료</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: color.text }}>
            📄 {fileName}
          </div>
        </div>

        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: color.text, marginBottom: 2 }}>
            {parsed.length}<span style={{ fontSize: 14, fontWeight: 600, color: color.textSecondary }}>명 인식됨</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {GROUPS.filter(g => grpCount[g] > 0).map(g => (
              <span key={g} style={chip(GROUP_COLOR[g] + '1a', GROUP_COLOR[g])}>
                {GROUP_LABEL[g]} {grpCount[g]}
              </span>
            ))}
            {unknownGroup > 0 && (
              <span style={chip(color.warningBg, color.warningStrong)}>
                ⚠ 그룹 미인식 {unknownGroup}
              </span>
            )}
          </div>

          <div style={{
            display: 'flex', gap: 8, marginTop: 12, padding: '10px 12px',
            background: color.bgMuted, borderRadius: radius.md, fontSize: 12,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: color.textSecondary, marginBottom: 2 }}>희망근무</div>
              <div style={{ fontWeight: 700, color: color.text }}>{reqCount}건</div>
            </div>
            <div style={{ width: 1, background: color.border }} />
            <div style={{ flex: 1 }}>
              <div style={{ color: color.textSecondary, marginBottom: 2 }}>특기사항</div>
              <div style={{ fontWeight: 700, color: color.text }}>{noteCount}건</div>
            </div>
          </div>

          {unknownGroup > 0 && (
            <div style={{
              marginTop: 10, padding: '8px 10px', borderRadius: radius.sm,
              background: color.warningBg, color: color.warningStrong, fontSize: 11, lineHeight: 1.5,
            }}>
              그룹을 인식하지 못한 {unknownGroup}명은 연차 기반으로 추정했습니다.
              명단 탭에서 그룹이 맞는지 확인해주세요.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '0 16px 16px' }}>
          <button onClick={() => { onParsed(parsed); reset() }}
            style={button('primary', { flex: 1, padding: '10px', fontSize: 13 })}>
            확인하고 명단에 반영
          </button>
          <button onClick={reset}
            style={button('ghost', { padding: '10px 14px', fontSize: 13 })}>
            다시 업로드
          </button>
        </div>
      </div>
    )
  }

  const borderColor = dragging ? color.accent : state === 'err' ? color.danger : color.border

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{
        border: `1.5px dashed ${borderColor}`,
        borderRadius: radius.lg,
        padding: '28px 20px',
        textAlign: 'center',
        background: dragging ? color.accentBg : color.bg,
        transition: 'all .15s',
        cursor: 'pointer',
      }}
      onClick={() => fileRef.current?.click()}
    >
      <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={onFileChange} />

      <div style={{ fontSize: 28, marginBottom: 8 }}>
        {state === 'loading' ? '⏳' : state === 'err' ? '❌' : '📂'}
      </div>

      {state === 'loading' ? (
        <div style={{ fontSize: 13, color: color.accent, fontWeight: 600 }}>파싱 중...</div>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: color.text, marginBottom: 4 }}>
            {dragging ? '여기에 놓으세요' : '희망근무 엑셀 업로드'}
          </div>
          <div style={{ fontSize: 12, color: color.textSecondary, marginBottom: 8 }}>
            클릭하거나 파일을 드래그하세요 · .xlsx / .xls
          </div>
          <div style={{ fontSize: 11, color: color.textSecondary, lineHeight: 1.7,
            background: color.bgMuted, borderRadius: radius.sm, padding: '8px 10px', display: 'inline-block', textAlign: 'left' }}>
            <b>병동 희망근무 양식 그대로 지원</b> — 조·사번·성명 + 일자별 희망<br/>
            그룹(CN·duty CN·야간전담·프리셉터·CN2·CN1)과 연차는 자동 인식<br/>
            희망 표기: <code>D^ E^ N^ OF^</code> · 교예/보예는 교육(고정)으로 처리<br/>
            <span style={{ opacity: 0.75 }}>간단 양식(이름·그룹·1일·2일...)도 지원합니다</span>
          </div>
        </>
      )}

      {state === 'err' && errMsg && (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: color.dangerStrong }}>
          ❌ {errMsg}
        </div>
      )}
    </div>
  )
}
