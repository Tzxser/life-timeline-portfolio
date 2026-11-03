'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import { ApiManagerIcon } from '@/components/common/header-icons'
import { getApiStatus, saveApiProfile, applyApiProfile, removeApiProfile, type ApiProfile, type ApiStatus } from '@/lib/ai-import'
import { useLifeStore } from '@/lib/life-store'
import { cn } from '@/lib/utils'
import { DiaryPageFrame, buttonBase, quietButton, primaryButton, fieldClass, errorText } from './diary-page-frame'

const emptyStatus: ApiStatus = { profiles: [], activeProfileId: null, usable: false }
const emptyForm = { id: null as string | null, name: '', baseUrl: '', model: '', apiKey: '' }

export function ApiManagerPage({ onClose, backLabel }: { onClose: () => void; backLabel?: string }) {
  const desktop = useLifeStore().platformKind === 'desktop'
  const [status, setStatus] = useState<ApiStatus>(emptyStatus)
  const [form, setForm] = useState(emptyForm)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const running = useRef(false)
  const selected = status.profiles.find((profile) => profile.id === form.id)
  const active = status.profiles.find((profile) => profile.id === status.activeProfileId)
  const complete = Boolean(form.name.trim() && form.baseUrl.trim() && form.model.trim() && (form.apiKey.trim() || selected?.hasKey))

  const selectProfile = (profile?: ApiProfile) => {
    setForm(profile ? { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, apiKey: '' } : emptyForm)
    setError(null)
    setNotice(null)
    setRemoving(false)
  }

  useEffect(() => {
    if (!desktop) return
    let alive = true
    setBusy('正在读取本机接口配置…')
    void getApiStatus().then((next) => {
      if (!alive) return
      setStatus(next)
      const first = next.profiles.find((profile) => profile.id === next.activeProfileId) ?? next.profiles[0]
      if (first) setForm({ id: first.id, name: first.name, baseUrl: first.baseUrl, model: first.model, apiKey: '' })
    }).catch((reason) => { if (alive) setError(errorText(reason, '读取配置失败，请稍后重试。')) })
      .finally(() => { if (alive) setBusy(null) })
    return () => { alive = false }
  }, [desktop])

  const save = async (apply: boolean) => {
    if (!desktop || running.current || !complete) return
    running.current = true
    setError(null)
    setNotice(null)
    setRemoving(false)
    setBusy('正在将配置保存在本机…')
    try {
      const previousIds = new Set(status.profiles.map((profile) => profile.id))
      const saved = await saveApiProfile({
        id: form.id, name: form.name.trim(), baseUrl: form.baseUrl.trim(), model: form.model.trim(),
        apiKey: form.apiKey.trim() || null,
      })
      // Keep only metadata in React state. A stored key is never read back.
      setForm((current) => ({ ...current, apiKey: '' }))
      setStatus(saved)
      const profile = saved.profiles.find((item) => item.id === form.id) ?? saved.profiles.find((item) => !previousIds.has(item.id))
      if (!profile) throw new Error('配置已保存，请返回后重新打开管理 API。')
      setForm({ id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, apiKey: '' })
      if (!apply) { setNotice('配置已保存。点击「保存并应用」完成可用性检查后，就能用于 AI 辅助导入。'); return }
      setBusy('正在检查接口与模型是否可用，请稍候…')
      const applied = await applyApiProfile(profile.id)
      setStatus(applied)
      const verified = applied.profiles.find((item) => item.id === applied.activeProfileId)
      setNotice(applied.usable
        ? `已应用「${verified?.name ?? profile.name}」。${verified?.supportsImages ? '可整理文字和照片。' : '文字已可用，图片识别尚未通过检查。导入照片前可更换模型或重新应用。'}`
        : '配置已保存，但尚未通过可用性检查。')
    } catch (reason) {
      // Keys and request payloads must never be logged or interpolated into UI errors.
      setError(errorText(reason, '保存或应用未完成，请检查接口地址、模型名称和密钥。'))
    } finally {
      setForm((current) => ({ ...current, apiKey: '' }))
      running.current = false
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!desktop || !selected || running.current) return
    running.current = true
    setError(null)
    setNotice(null)
    setBusy('正在移除这份接口配置…')
    try {
      const next = await removeApiProfile(selected.id)
      setStatus(next)
      selectProfile()
      setNotice('配置和保存在本机的对应密钥已移除。')
    } catch (reason) { setError(errorText(reason, '移除失败，请稍后重试。')) }
    finally { running.current = false; setBusy(null) }
  }

  return (
    <DiaryPageFrame mode="api" busy={busy} onClose={onClose} backLabel={backLabel}>
      <section aria-label="AI 接口设置">
        <h2 className="font-serif text-2xl leading-relaxed md:text-3xl">由你选择，谁来帮忙整理</h2>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">添加支持 OpenAI 兼容格式的接口。保存并应用成功后，才会启用 AI 辅助导入。</p>
        {!desktop && <p role="note" className="mt-5 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm leading-7 text-muted-foreground">接口配置与密钥保存在桌面版的本机安全存储中。这里仅展示设置页面。</p>}
        <div className="mt-7 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-4">
          <div>
            <p className="text-xs text-muted-foreground">当前使用</p>
            <p className="mt-1.5 text-sm">{status.usable && active ? active.name : '尚未应用可用接口'}</p>
            {status.usable && active && <p className="mt-1 text-xs text-muted-foreground">{active.model} · {active.supportsImages ? '文字与图片' : '文字可用 · 图片待验证'}</p>}
          </div>
          {status.usable && <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs text-primary"><Check className="size-3" />已可用</span>}
        </div>
        {status.profiles.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-2" aria-label="已保存的接口">
            {status.profiles.map((profile) => <button key={profile.id} type="button" disabled={Boolean(busy)} onClick={() => selectProfile(profile)} aria-pressed={form.id === profile.id} className={cn('rounded-md border px-3 py-2 text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40', form.id === profile.id ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground')}>{profile.name}{profile.id === status.activeProfileId && status.usable ? ' · 使用中' : ''}</button>)}
            <button type="button" disabled={Boolean(busy)} onClick={() => selectProfile()} className={cn(quietButton, 'inline-flex items-center gap-1.5 px-3 py-2 text-xs')}><Plus className="size-3" />添加接口</button>
          </div>
        )}
        <form autoComplete="off" className="mt-7" onSubmit={(event) => { event.preventDefault(); void save(true) }}>
          <fieldset disabled={Boolean(busy) || !desktop} className="space-y-5">
            <legend className="mb-4 font-serif text-lg">{selected ? '编辑接口' : status.profiles.length ? '添加接口' : '添加第一个接口'}</legend>
            <label className="block text-xs text-muted-foreground">配置名称<input aria-label="配置名称" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="给这个接口起一个方便辨认的名字" maxLength={80} className={cn(fieldClass, 'mt-2')} /></label>
            <label className="block text-xs text-muted-foreground">接口地址<input aria-label="接口地址" value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://你的服务地址/v1" inputMode="url" spellCheck={false} maxLength={2048} className={cn(fieldClass, 'mt-2 font-mono')} /><span className="mt-2 block leading-6">填写服务商提供的兼容接口地址，请使用 HTTPS；本机部署的服务也可使用本地地址。</span></label>
            <label className="block text-xs text-muted-foreground">模型名称<input aria-label="模型名称" value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} placeholder="填写服务商提供的模型名称" spellCheck={false} maxLength={160} className={cn(fieldClass, 'mt-2 font-mono')} /><span className="mt-2 block leading-6">照片日记需要支持图片识别的模型，应用时会一并检查。</span></label>
            <label className="block text-xs text-muted-foreground">API 密钥<input aria-label="API 密钥" type="password" name="life-timeline-api-key" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" spellCheck={false} value={form.apiKey} onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder={selected?.hasKey ? '密钥已保存；留空继续使用，更换时再输入' : '在这里粘贴你的 API 密钥'} maxLength={8192} className={cn(fieldClass, 'mt-2 font-mono')} /><span className="mt-2 block leading-6">密钥仅保存在本机，保存后输入框会清空。不会随日记导出或备份带走。</span></label>
          </fieldset>
          <p className="mt-6 text-xs leading-6 text-muted-foreground">「保存并应用」会向这个地址发送少量测试内容，检查文字与图片能力，不包含你的日记。实际使用产生的费用按服务商规则计算。</p>
          {error && <p role="alert" className="mt-5 text-sm leading-7 text-destructive">{error}</p>}
          {notice && <p role="status" className="mt-5 text-sm leading-7 text-muted-foreground">{notice}</p>}
          <div className="mt-7 flex flex-wrap gap-3">
            <button type="submit" disabled={!desktop || Boolean(busy) || !complete} className={cn(primaryButton, 'lt-hbtn inline-flex items-center gap-2')}><ApiManagerIcon className="size-4" />保存并应用</button>
            <button type="button" disabled={!desktop || Boolean(busy) || !complete} onClick={() => void save(false)} className={quietButton}>仅保存配置</button>
            <button type="button" disabled={Boolean(busy)} onClick={onClose} className={quietButton}>返回</button>
            {selected && <button type="button" disabled={Boolean(busy)} onClick={() => setRemoving(true)} className={cn(buttonBase, 'ml-auto inline-flex items-center gap-1.5 text-muted-foreground hover:bg-muted hover:text-destructive')}><Trash2 className="size-3.5" />移除此接口</button>}
          </div>
        </form>
        {removing && selected && <div role="alertdialog" aria-label="确认移除接口" className="mt-6 rounded-lg border border-border bg-muted/30 p-5"><p className="text-sm leading-7">移除「{selected.name}」及它保存在本机的密钥？{selected.id === status.activeProfileId ? '移除后，需重新应用另一个接口才能进行 AI 整理。' : ''}</p><div className="mt-4 flex gap-3"><button type="button" disabled={Boolean(busy)} className={quietButton} onClick={() => setRemoving(false)}>保留</button><button type="button" disabled={Boolean(busy)} className={primaryButton} onClick={() => void remove()}>确认移除</button></div></div>}
      </section>
    </DiaryPageFrame>
  )
}
