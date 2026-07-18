import { useRef, useState } from 'react'
import type { Nurse } from '../types'
import { parseExcel } from '../utils/api'

interface Props {
  onParsed: (nurses: Nurse[]) => void
}

export default function UploadPanel({ onParsed }: Props) {
  const fileRef  = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<'idle'|'loading'|'ok'|'err'>('idle')
  const [msg,   setMsg]   = useState('')
  const [dragging, setDragging] = useState(false)

  async function process(file: File) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setState('err'); setMsg('xlsx 또는 xls 파일만 허용됩니다'); return
    }
    setState('loading'); setMsg('')
    try {
      const { nurses, count } = await parseExcel(file)
      onParsed(nurses)
      setState('ok'); setMsg(`${count}명 불러오기 완료`)
    } catch (e: any) {
      setState('err'); setMsg(e.message ?? '파싱 오류')
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

  const borderColor = dragging ? '#2563eb' : state === 'ok' ? '#059669' : state === 'err' ? '#dc2626' : 'var(--color-border-secondary)'

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{
        border: `2px dashed ${borderColor}`,
        borderRadius: 10,
        padding: '28px 20px',
        textAlign: 'center',
        background: dragging ? '#eff6ff' : 'var(--color-background-primary)',
        transition: 'all .15s',
        cursor: 'pointer',
      }}
      onClick={() => fileRef.current?.click()}
    >
      <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={onFileChange} />

      <div style={{ fontSize: 28, marginBottom: 8 }}>
        {state === 'loading' ? '⏳' : state === 'ok' ? '✅' : state === 'err' ? '❌' : '📂'}
      </div>

      {state === 'loading' ? (
        <div style={{ fontSize: 13, color: '#2563eb' }}>파싱 중...</div>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
            {dragging ? '여기에 놓으세요' : '희망근무 엑셀 업로드'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            클릭하거나 파일을 드래그하세요 · .xlsx / .xls
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.7,
            background: 'var(--color-background-secondary)', borderRadius: 6, padding: '8px 10px', display: 'inline-block', textAlign: 'left' }}>
            <b>병동 희망근무 양식 그대로 지원</b> — 조·사번·성명 + 일자별 희망<br/>
            그룹(CN·duty CN·야간전담·프리셉터·CN2·CN1)과 연차는 자동 인식<br/>
            희망 표기: <code>D^ E^ N^ OF^</code> · 교예/보예는 교육(고정)으로 처리<br/>
            <span style={{ opacity: 0.75 }}>간단 양식(이름·그룹·1일·2일...)도 지원합니다</span>
          </div>
        </>
      )}

      {msg && (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 500,
          color: state === 'ok' ? '#065f46' : '#991b1b' }}>
          {state === 'ok' ? '✅ ' : '❌ '}{msg}
        </div>
      )}
    </div>
  )
}
