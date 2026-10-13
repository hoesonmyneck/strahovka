import React, { useState, useEffect, useCallback } from 'react'
import api from '../utils/api.js'
import { Shield, Coins, Activity } from 'lucide-react'
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

// Полярная роза: лепестки из центра, радиус = значение
function HudRose({ items }) {
  const data = items.slice(0, 10)
  const max = Math.max(1, ...data.map((d) => d.value))
  const cx = 150, cy = 150, maxR = 120, minR = 24
  const n = data.length || 1
  const slice = (Math.PI * 2) / n
  const gap = n > 1 ? 0.045 : 0
  const polar = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  return (
    <div className="hud-rose">
      <svg viewBox="0 0 300 300">
        {[0.34, 0.67, 1].map((f, i) => (
          <circle key={i} cx={cx} cy={cy} r={minR + (maxR - minR) * f} className="hud-rose-grid" />
        ))}
        {data.map((d, i) => {
          const r = minR + (d.value / max) * (maxR - minR)
          const a0 = i * slice - Math.PI / 2 + gap
          const a1 = (i + 1) * slice - Math.PI / 2 - gap
          const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1)
          const large = (a1 - a0) > Math.PI ? 1 : 0
          const dpath = `M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r.toFixed(2)},${r.toFixed(2)} 0 ${large},1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`
          return (
            <path key={d.label + i} className="hud-rose-petal" d={dpath} fill={C[i % C.length]}
              style={{ '--d': `${i * 80}ms` }}>
              <title>{d.label}: {fmtNum(d.value)}</title>
            </path>
          )
        })}
      </svg>
      <div className="hud-rose-legend">
        {data.map((d, i) => (
          <div key={d.label + i} className="hud-rose-leg" title={`${d.label}: ${fmtNum(d.value)}`}>
            <i style={{ background: C[i % C.length] }} />
            <span className="hud-rose-leg-l">{d.label}</span>
            <b>{fmtNum(d.value)}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

// Пузырьки: размер = значение, плотная облачная раскладка
function HudBubbles({ items }) {
  const data = items.slice(0, 8)
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div className="hud-bubbles">
      {data.map((d, i) => {
        const size = Math.round(52 + Math.sqrt(d.value / max) * 94)
        return (
          <div className="hud-bubble-cell" key={d.label + i} title={`${d.label}: ${fmtNum(d.value)}`}>
            <div className="hud-bubble" style={{ width: size, height: size, '--c': C[i % C.length], '--d': `${i * 110}ms` }}>
              <span className="hud-bubble-v">{fmtShort(d.value)}</span>
            </div>
            <span className="hud-bubble-l">{d.label}</span>
          </div>
        )
      })}
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

// Короткий формат для центра кольца: 53К, 1,2М
const fmtShort = (v) => {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace('.', ',') + 'Б'
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + 'М'
  if (a >= 1e3) return Math.round(v / 1e3) + 'К'
  return String(Math.round(v))
}

const R_G = 46, CIRC_G = 2 * Math.PI * R_G

// Одно радиальное кольцо-гейдж
function Gauge({ arc, center, label, tip, color, idx }) {
  const off = CIRC_G - Math.max(0, Math.min(100, arc)) / 100 * CIRC_G
  return (
    <div className="hud-gauge" title={tip}>
      <svg viewBox="0 0 120 120">
        <circle className="hud-gauge-bg" cx="60" cy="60" r={R_G} />
        <circle className="hud-gauge-fg" cx="60" cy="60" r={R_G} stroke="currentColor"
          strokeDasharray={CIRC_G}
          style={{ color, '--circ': CIRC_G, '--off': off, '--d': `${idx * 90}ms` }} />
        <text className="hud-gauge-num" x="60" y="60" dominantBaseline="central">{center}</text>
      </svg>
      <div className="hud-gauge-label" title={label}>{label}</div>
    </div>
  )
}

// Сетка радиальных колец. Если есть insured/not_insured — кольцо = охват %;
// иначе кольцо = доля от максимума, в центре — само значение.
function HudGauges({ items, color = 'var(--h-cyan)', coverage = false }) {
  const max = coverage ? 100 : Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="hud-gauges">
      {items.map((it, i) => {
        if (coverage) {
          const tot = it.insured + it.not_insured || 1
          const cov = (it.insured / tot) * 100
          return <Gauge key={it.label + i} idx={i} color={color} arc={cov}
            center={`${cov.toFixed(0)}%`} label={it.label}
            tip={`${it.label}: ${fmtNum(it.insured)} из ${fmtNum(tot)} застрахованы`} />
        }
        return <Gauge key={it.label + i} idx={i} color={color} arc={(it.value / max) * 100}
          center={fmtShort(it.value)} label={it.label}
          tip={`${it.label}: ${fmtNum(it.value)}`} />
      })}
    </div>
  )
}

// Рейтинг-лидерборд: место, название, бар, значение (топ-3 подсвечены)
function HudRanking({ items, format = fmtNum, color = 'var(--h-cyan)' }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="hud-rank">
      {items.map((it, i) => (
        <div className="hud-rank-row" key={it.label + i} title={`${it.label}: ${format(it.value)}`}>
          <span className={'hud-rank-pos' + (i < 3 ? ' top top' + (i + 1) : '')}>{i + 1}</span>
          <span className="hud-rank-label">{it.label}</span>
          <span className="hud-rank-track">
            <span className="hud-rank-fill" style={{ width: `${(it.value / max) * 100}%`, background: color, '--d': `${i * 55}ms` }} />
          </span>
          <span className="hud-rank-val">{format(it.value)}</span>
        </div>
      ))}
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

// Активность заходов по регионам за месяц (гит-календарь)
function HudActivity() {
  const [data, setData] = useState(null)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (m) => {
    const [y, mo] = (m || '').split('-')
    if (!y || !mo) return
    setLoading(true)
    try {
      const res = await api.get('/api/logs/heatmap', { params: { year: Number(y), month: Number(mo) } })
      setData(res.data)
    } catch { setData(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(month) }, [month, load])

  return (
    <HudCard title="Активность заходов по регионам" wide>
      <div className="hud-activity-bar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="hud-month" />
        {data && <span className="hud-activity-hint">дни месяца · число заходов за день</span>}
      </div>
      {loading && !data ? (
        <div className="hud-act-empty">Загрузка…</div>
      ) : !data || data.regions.length === 0 ? (
        <div className="hud-act-empty">Нет заходов за выбранный месяц</div>
      ) : (
        <div className="hud-heatmap">
          {data.regions.map((r) => {
            const maxv = Math.max(1, ...r.days)
            return (
              <div className="hud-hm-row" key={r.region}>
                <span className="hud-hm-region" title={r.region}>{r.region}</span>
                <div className="hud-hm-days">
                  {r.days.map((c, di) => (
                    <span key={di} className={'hud-hm-cell' + (c > 0 ? ' on' : '')}
                      title={`День ${di + 1}: ${c} заход.`}
                      style={c > 0 ? { '--lvl': Math.min(1, 0.3 + 0.7 * (c / maxv)) } : undefined}>
                      {c > 0 ? c : ''}
                    </span>
                  ))}
                </div>
                <span className="hud-hm-tot"><b>{r.active_days}</b> дн · <b>{r.total}</b></span>
              </div>
            )
          })}
        </div>
      )}
    </HudCard>
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
    { label: 'Сумма застрахованных', value: ins.sum_amount, format: fmtCompact, note: 'по действующим',
      spark: barSpark(ins.by_region.map((r) => ({ label: r.label, value: r.total })), C[0], fmtNum) },
    { label: 'Всего сотрудников', value: ins.tot_emp, note: 'по организациям',
      spark: lineSpark(ins.by_region.map((r) => ({ label: r.label, value: r.total })), C[1], fmtNum) },
    { label: 'Застрах. сотрудников', value: ins.ins_emp, note: 'человек',
      spark: lineSpark(ins.by_region.map((r) => ({ label: r.label, value: r.insured })), C[2], fmtNum) },
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
      </div>

      <h2 className="hud-h2"><Shield size={18} /> Страхование</h2>
      <KpiPanel tiles={insTiles} cols={4} />
      <div className="hud-charts">
        <HudCard title="Рейтинг регионов по застрахованным" wide>
          <HudRanking
            items={[...ins.by_region].sort((a, b) => b.insured - a.insured).map((r) => ({ label: r.label, value: r.insured }))}
            color="var(--h-cyan)" />
        </HudCard>
        <HudCard title="Форма предприятия">
          <HudDonut a={ins.ul_cnt} b={ins.ip_cnt} labelA="ЮЛ" labelB="ИП" />
          <div className="hud-donut-extra">
            <div className="hud-donut-extra-title">Застрахованы</div>
            <div><i style={{ background: 'var(--h-cyan)' }} /> ЮЛ: <b>{fmtNum(ins.ul_ins)}</b> <span className="dim">из {fmtNum(ins.ul_cnt)}</span></div>
            <div><i style={{ background: 'var(--h-amber)' }} /> ИП: <b>{fmtNum(ins.ip_ins)}</b> <span className="dim">из {fmtNum(ins.ip_cnt)}</span></div>
          </div>
        </HudCard>
      </div>
      {ins.by_status && ins.by_status.length > 0 && (
        <div className="hud-charts">
          <HudCard title="Рейтинг статусов" wide>
            <HudRanking items={ins.by_status} color="var(--h-blue)" />
          </HudCard>
        </div>
      )}

      {op && (
        <>
          <h2 className="hud-h2"><Coins size={18} /> Анализ ОППВ</h2>
          <KpiPanel tiles={opTiles} cols={3} />
          <div className="hud-charts">
            <HudCard title="Рейтинг ОКЭД по сотрудникам" wide>
              <HudRanking items={op.by_oked} color="var(--h-teal)" />
            </HudCard>
          </div>
        </>
      )}

      <h2 className="hud-h2"><Activity size={18} /> Активность</h2>
      <div className="hud-charts"><HudActivity /></div>
    </div>
  )
}

export default DashboardHud
