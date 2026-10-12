import React, { useState, useEffect, useCallback } from 'react'
import api from '../utils/api.js'
import { RefreshCw, Shield, Coins } from 'lucide-react'
import { KpiSpark, CountUp } from './KpiSpark.jsx'

// ─── Форматирование ──────────────────────────────────────────────────────────
const fmtNum = (v) => {
  if (v == null || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('ru-RU')
}
const fmtCompact = (v) => {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const r = (x, s) => (x).toFixed(1).replace('.', ',') + ' ' + s
  if (a >= 1e12) return r(v / 1e12, 'трлн')
  if (a >= 1e9) return r(v / 1e9, 'млрд')
  if (a >= 1e6) return r(v / 1e6, 'млн')
  if (a >= 1e3) return Math.round(v / 1e3) + ' тыс'
  return fmtNum(v)
}
const fmtPct = (v) => (v == null ? '—' : v.toFixed(1).replace('.', ',') + '%')

const C = ['var(--h-cyan)', 'var(--h-blue)', 'var(--h-teal)', 'var(--h-amber)', '#9b8cff']

// Декоративный spark из массива {label,value}
const barSpark = (arr, color, format) =>
  arr && arr.length >= 2 ? { kind: 'bar', labels: arr.map((a) => a.label), values: arr.map((a) => a.value), format, color } : undefined
const lineSpark = (arr, color, format) =>
  arr && arr.length >= 2 ? { kind: 'line', labels: arr.map((a) => a.label), values: arr.map((a) => a.value), format, color } : undefined

// ─── Панель KPI (плитки с мини-графиком в подложке) ──────────────────────────
function KpiPanel({ tiles, cols }) {
  return (
    <div className="hud-card kpi-panel">
      <div className="kpi-grid" style={{ '--cols': cols || 4 }}>
        {tiles.map((t, i) => (
          <div className="kpi-tile" key={t.label} style={{ '--i': i }}>
            {t.spark && <KpiSpark spark={t.spark} delay={i * 140} />}
            <div className="kpi-label">{t.label}</div>
            {t.pair ? (
              <div className="kpi-pair">
                {t.pair.map((p) => (
                  <div className="kpi-pair-row" key={p.label}>
                    <span className="kpi-pair-l">{p.label}</span>
                    <span className="kpi-value kpi-value--sm"><CountUp value={p.value} format={fmtNum} /></span>
                    <span className="kpi-note">{p.note}</span>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className={'kpi-value' + (t.accent ? ' kpi-value--accent' : '')}>
                  <CountUp value={t.value} format={t.format || fmtNum} />
                </div>
                <div className="kpi-note">{t.note}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Карточка-обёртка для графиков ───────────────────────────────────────────
function HudCard({ title, children, wide }) {
  return (
    <div className={'hud-card hud-chart-card' + (wide ? ' hud-chart-card--wide' : '')}>
      <div className="hud-chart-title">{title}</div>
      {children}
    </div>
  )
}

// Горизонтальные столбцы: регион/название — бар — число
function HudBars({ items, color = 'var(--h-cyan)', format = fmtNum }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="hud-bars">
      {items.map((it, i) => (
        <div className="hud-bar-row" key={it.label + i}>
          <span className="hud-bar-label" title={it.label}>{it.label}</span>
          <span className="hud-bar-track">
            <span className="hud-bar-fill" style={{ width: `${(it.value / max) * 100}%`, background: color, '--d': `${i * 70}ms` }} />
          </span>
          <span className="hud-bar-val">{format(it.value)}</span>
        </div>
      ))}
    </div>
  )
}

// Регионы: доля застрахованных (split-бар insured/not_insured)
function HudСoverageBars({ items }) {
  return (
    <div className="hud-bars">
      {items.map((it, i) => {
        const t = it.insured + it.not_insured || 1
        const cov = (it.insured / t) * 100
        return (
          <div className="hud-bar-row" key={it.label + i}>
            <span className="hud-bar-label" title={it.label}>{it.label}</span>
            <span className="hud-bar-track hud-bar-track--split">
              <span className="hud-bar-fill" style={{ width: `${cov}%`, background: 'var(--h-cyan)', '--d': `${i * 70}ms` }} />
              <span className="hud-bar-fill hud-bar-fill--2" style={{ width: `${100 - cov}%`, background: 'var(--h-amber)', '--d': `${i * 70}ms` }} />
            </span>
            <span className="hud-bar-val">{cov.toFixed(0)}%</span>
          </div>
        )
      })}
    </div>
  )
}

// Донат из двух сегментов + легенда
function HudDonut({ a, b, labelA, labelB }) {
  const total = a + b || 1
  const pa = a / total
  const R = 54, CIRC = 2 * Math.PI * R
  const dashA = pa * CIRC
  return (
    <div className="hud-donut-wrap">
      <svg viewBox="0 0 140 140" className="hud-donut">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--h-amber)" strokeWidth="18" opacity="0.55" />
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--h-cyan)" strokeWidth="18"
          strokeDasharray={`${dashA} ${CIRC}`} strokeLinecap="round"
          transform="rotate(-90 70 70)" className="hud-donut-arc" />
        <text x="70" y="66" className="hud-donut-num">{Math.round(pa * 100)}%</text>
        <text x="70" y="84" className="hud-donut-sub">{labelA}</text>
      </svg>
      <div className="hud-donut-legend">
        <div><i style={{ background: 'var(--h-cyan)' }} /> {labelA}: <b>{fmtNum(a)}</b></div>
        <div><i style={{ background: 'var(--h-amber)' }} /> {labelB}: <b>{fmtNum(b)}</b></div>
      </div>
    </div>
  )
}

// ─── Основной компонент ──────────────────────────────────────────────────────
const DashboardHud = () => {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/api/dashboard/kpis')
      setData(res.data)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading && !data) {
    return <div className="hud-view"><div className="hud-loading">Загрузка показателей…</div></div>
  }
  if (!data) {
    return <div className="hud-view"><div className="hud-loading">Нет данных</div></div>
  }

  const ins = data.insurance
  const op = data.oppv

  const insTiles = [
    { label: 'Всего организаций', value: ins.total_bins, accent: true, note: 'уникальных БИН',
      spark: lineSpark(ins.by_region.map((r) => ({ label: r.label, value: r.total })), C[0], fmtNum) },
    { label: 'Застрахованы', value: ins.insured_bins, note: fmtPct(ins.coverage_pct) + ' охват',
      spark: barSpark(ins.by_region.map((r) => ({ label: r.label, value: r.insured })), C[2], fmtNum) },
    { label: 'Не застрахованы', value: ins.not_insured_bins, note: 'обязаны, без договора',
      spark: barSpark(ins.by_region.map((r) => ({ label: r.label, value: r.not_insured })), C[3], fmtNum) },
    { label: 'Охват', value: ins.coverage_pct, format: fmtPct, note: 'доля застрахованных',
      spark: barSpark(ins.by_region.map((r) => ({ label: r.label, value: Math.round((r.insured / (r.insured + r.not_insured || 1)) * 100) })), C[1], (v) => v + '%') },
    { label: 'Сумма премий', value: ins.sum_amount, format: fmtCompact, note: 'по действующим',
      spark: barSpark(ins.by_region.map((r) => ({ label: r.label, value: r.total })), C[0], fmtNum) },
    { label: 'Застрах. сотрудников', value: ins.ins_emp, note: 'человек',
      spark: lineSpark(ins.by_region.map((r) => ({ label: r.label, value: r.insured })), C[2], fmtNum) },
    { label: 'Всего сотрудников', value: ins.tot_emp, note: 'по организациям',
      spark: lineSpark(ins.by_region.map((r) => ({ label: r.label, value: r.total })), C[1], fmtNum) },
    { label: 'Форма предприятия', pair: [
        { label: 'ЮЛ', value: ins.ul_cnt, note: fmtPct((ins.ul_cnt / (ins.ul_cnt + ins.ip_cnt || 1)) * 100) },
        { label: 'ИП', value: ins.ip_cnt, note: fmtPct((ins.ip_cnt / (ins.ul_cnt + ins.ip_cnt || 1)) * 100) },
      ] },
  ]

  const opTiles = op ? [
    { label: 'Записей ОППВ', value: op.rows, accent: true, note: 'строк выгрузки',
      spark: barSpark(op.by_region, C[0], fmtNum) },
    { label: 'Сотрудников', value: op.sum_cnt, note: 'суммарно',
      spark: barSpark(op.by_region, C[2], fmtNum) },
    { label: 'Сумма ФОТ', value: op.sum_fot, format: fmtCompact, note: 'фонд оплаты труда',
      spark: barSpark(op.by_oked, C[1], fmtNum) },
    { label: 'Средняя СМЗ', value: op.avg_smz, format: fmtCompact, note: 'средняя зарплата',
      spark: lineSpark(op.by_region, C[3], fmtNum) },
    { label: 'Мужчины', value: op.male, note: fmtPct((op.male / (op.male + op.female || 1)) * 100),
      spark: barSpark(op.by_region, C[1], fmtNum) },
    { label: 'Женщины', value: op.female, note: fmtPct((op.female / (op.male + op.female || 1)) * 100),
      spark: barSpark(op.by_oked, C[4], fmtNum) },
  ] : []

  return (
    <div className="hud-view">
      <div className="hud-topline">
        <div className="hud-topline-title">Аналитический дашборд</div>
        <button className="hud-refresh" onClick={load} title="Обновить">
          <RefreshCw size={16} /> Обновить
        </button>
      </div>

      <h2 className="hud-h2"><Shield size={18} /> Страхование</h2>
      <KpiPanel tiles={insTiles} cols={4} />
      <div className="hud-charts">
        <HudCard title="Охват по регионам (застрахованы / нет)" wide>
          <HudСoverageBars items={ins.by_region} />
        </HudCard>
        <HudCard title="Форма предприятия">
          <HudDonut a={ins.ul_cnt} b={ins.ip_cnt} labelA="ЮЛ" labelB="ИП" />
        </HudCard>
      </div>
      {ins.by_status && ins.by_status.length > 0 && (
        <div className="hud-charts">
          <HudCard title="Проставленные статусы" wide>
            <HudBars items={ins.by_status} color="var(--h-blue)" />
          </HudCard>
        </div>
      )}

      {op && (
        <>
          <h2 className="hud-h2"><Coins size={18} /> Анализ ОППВ</h2>
          <KpiPanel tiles={opTiles} cols={3} />
          <div className="hud-charts">
            <HudCard title="Сотрудники по регионам">
              <HudBars items={op.by_region} color="var(--h-cyan)" />
            </HudCard>
            <HudCard title="Гендерный состав">
              <HudDonut a={op.male} b={op.female} labelA="Мужчины" labelB="Женщины" />
            </HudCard>
          </div>
          <div className="hud-charts">
            <HudCard title="Топ видов деятельности (ОКЭД) по сотрудникам" wide>
              <HudBars items={op.by_oked} color="var(--h-teal)" />
            </HudCard>
          </div>
        </>
      )}
    </div>
  )
}

export default DashboardHud
