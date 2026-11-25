import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import api from '../utils/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { Shield, Coins, Activity, Download, ListTree, ChevronLeft, ChevronRight } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { KpiSpark, CountUp } from './KpiSpark.jsx'

// ─── Форматирование ──────────────────────────────────────────────────────────
const fmtNum = (v) => {
  if (v == null || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('ru-RU')
}
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
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
function HudCard({ title, children, wide, id }) {
  return (
    <div id={id} className={'hud-card hud-chart-card' + (wide ? ' hud-chart-card--wide' : '')}>
      {title && <div className="hud-chart-title">{title}</div>}
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
// «Акционерное общество "…"» → «АО "…"»: в рейтингах страховых длинное название
// не помещалось. Полное название остаётся в подсказке при наведении.
const shortOrgName = (s) => String(s || '').replace(/акционерное\s+общество/gi, 'АО').replace(/\s{2,}/g, ' ').trim()
const withShortNames = (items) => items.map((it) => ({ ...it, title: it.label, label: shortOrgName(it.label) }))

// Разбивка по размеру предприятия в строке рейтинга (если сервер её прислал):
// полоса делится на сегменты, под названием — числа.
const SIZE_PARTS = [
  { key: 'Крупное', label: 'крупные', cls: 'big' },
  { key: 'Среднее', label: 'средние', cls: 'mid' },
  { key: 'Малое', label: 'малые', cls: 'small' },
]
const sizesTitle = (s) => SIZE_PARTS.map((p) => `${p.label} ${fmtNum(s[p.key] || 0)}`).join(', ')
// сколько предприятий без указанного размера (общее число минус три размера)
const restOf = (it) => Math.max(0, (it.value || 0) - SIZE_PARTS.reduce((a, p) => a + (it.sizes?.[p.key] || 0), 0))

function HudRanking({ items, format = fmtNum, color = 'var(--h-cyan)' }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="hud-rank">
      {items.map((it, i) => (
        <div className={'hud-rank-row' + (it.sizes ? ' with-sizes' : '')} key={it.label + i}
          title={`${it.title || it.label}: ${format(it.value)}` + (it.sizes ? ` (${sizesTitle(it.sizes)})` : '')}>
          <span className={'hud-rank-pos' + (i < 3 ? ' top top' + (i + 1) : '')}>{i + 1}</span>
          <span className="hud-rank-label">
            {it.label}
            {it.sizes && (
              <span className="hud-rank-sizes">
                {SIZE_PARTS.map((p) => (
                  <span key={p.key} className={'hud-sz ' + p.cls}><i />{p.label} <b>{fmtNum(it.sizes[p.key] || 0)}</b></span>
                ))}
                {restOf(it) > 0 && <span className="hud-sz rest"><i />не указан <b>{fmtNum(restOf(it))}</b></span>}
              </span>
            )}
          </span>
          <span className="hud-rank-track">
            {it.sizes ? (
              // сегменты: доля каждого размера от общего числа; длина полосы — как раньше
              <span className="hud-rank-fill hud-rank-stack" style={{ width: `${(it.value / max) * 100}%`, '--d': `${i * 55}ms` }}>
                {SIZE_PARTS.map((p) => (
                  <span key={p.key} className={'hud-seg ' + p.cls}
                    style={{ width: `${it.value ? ((it.sizes[p.key] || 0) / it.value) * 100 : 0}%` }} />
                ))}
                <span className="hud-seg rest" />
              </span>
            ) : (
              <span className="hud-rank-fill" style={{ width: `${(it.value / max) * 100}%`, background: color, '--d': `${i * 55}ms` }} />
            )}
          </span>
          <span className="hud-rank-val">{format(it.value)}</span>
        </div>
      ))}
    </div>
  )
}

// Рейтинг регионов по заполненности статусов: место, регион, бар (%), числа
function HudFillRanking({ rows }) {
  return (
    <div className="hud-rank">
      {rows.map((r, i) => {
        // строка всей области (у регионального) идёт первой и места в рейтинге не занимает
        const place = i - (rows[0]?.is_total ? 1 : 0)
        return (
        <div className={'hud-rank-row hud-fill-row' + (r.is_total ? ' hud-row-total' : '')} key={r.region + i}
          title={`${r.region}: заполнено ${fmtNum(r.filled)} из ${fmtNum(r.total)} (${fmtPct(r.pct)})`}>
          {r.is_total
            ? <span className="hud-rank-pos hud-pos-total">Σ</span>
            : <span className={'hud-rank-pos' + (place < 3 ? ' top top' + (place + 1) : '')}>{place + 1}</span>}
          <span className="hud-rank-label">{r.region}</span>
          <span className="hud-rank-track">
            <span className="hud-rank-fill" style={{ width: `${Math.min(100, r.pct)}%`, background: 'var(--h-cyan)', '--d': `${i * 45}ms` }} />
          </span>
          <span className="hud-fill-val"><b>{fmtPct(r.pct)}</b> <span className="dim">{fmtNum(r.filled)}/{fmtNum(r.total)}</span></span>
        </div>
        )
      })}
    </div>
  )
}

// Таблица по регионам: предприятия (всего/ИП/ЮЛ), застрахованы, % , не застрахованы (всего/ИП/ЮЛ)
function HudRegionTable({ rows, district }) {
  return (
    <div className="hud-rtable-wrap">
      <table className="hud-rtable">
        <thead>
          <tr>
            <th rowSpan={2} className="hud-rt-region">{district ? 'Район' : 'Регион'}</th>
            <th colSpan={3}>Кол-во предприятий</th>
            <th rowSpan={2}>Застра&shy;хованных</th>
            <th rowSpan={2}>% страхо&shy;вания</th>
            <th colSpan={3}>Не застрахованы</th>
          </tr>
          <tr>
            <th>Всего</th><th>ЮЛ</th><th>ИП</th>
            <th>Всего</th><th>ЮЛ</th><th>ИП</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.region + i} className={r.is_total ? 'hud-rt-total' : undefined}>
              <td className="hud-rt-region" title={r.region}>{r.region}</td>
              <td className="num strong">{fmtNum(r.total)}</td>
              <td className="num">{fmtNum(r.ul_total)}</td>
              <td className="num">{fmtNum(r.ip_total)}</td>
              <td className="num ins">{fmtNum(r.insured)}</td>
              <td className="num"><span className="hud-rt-cov">{fmtPct(r.coverage)}</span></td>
              <td className="num strong">{fmtNum(r.not_insured)}</td>
              <td className="num">{fmtNum(r.ul_not_insured)}</td>
              <td className="num">{fmtNum(r.ip_not_insured)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Скачать таблицу «Рейтинг ГАКа» в Excel (с текущим фильтром области/района)
function GakExportButton({ geo }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const res = await api.get('/api/dashboard/gak-rating/export', { params: geo, responseType: 'blob' })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.setAttribute('download', ['Рейтинг_ГАКа', geo.region, geo.district].filter(Boolean).join('_') + '.xlsx')
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      alert('Не удалось сформировать Excel')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hud-activity-bar">
      <button type="button" className="hud-export-btn" onClick={run} disabled={busy}>
        <Download size={15} /> {busy ? 'Формирую…' : 'Скачать Excel'}
      </button>
    </div>
  )
}

// Место ГАК: 1–5 — зелёный, 6–7 — жёлтый, дальше — без цвета
function GakRank({ rank }) {
  if (!rank) return <span className="dim">—</span>
  return <span className={'hud-gak-rank' + (rank <= 5 ? ' good' : rank <= 7 ? ' mid' : '')}>{rank}</span>
}

// Рейтинг ГАКа: место ГАК среди страховых в регионе и доля застрахованных ГАК
function HudGakTable({ rows, district }) {
  const pct = (v) => fmtPct(v)
  return (
    <div className="hud-rtable-wrap">
      <table className="hud-rtable hud-gak-table">
        <thead>
          <tr>
            <th className="hud-rt-region">{district ? 'Район' : 'Регион'}</th>
            <th>Рейтинг ГАКа в регионе</th>
            <th>Кол-во предприятий</th>
            <th>Кол-во предприятий застрахованных ГАКом</th>
            <th>% застрахованных</th>
            <th>Рейтинг ГАКа в регионе по количеству людей</th>
            <th>Кол-во людей</th>
            <th>Кол-во людей застрахованных ГАКом</th>
            <th>% застрахованных</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.region + i} className={r.is_total ? 'hud-rt-total' : undefined}>
              <td className="hud-rt-region" title={r.region}>{r.region}</td>
              <td className="num center">
                <GakRank rank={r.rank} />
              </td>
              <td className="num strong">{fmtNum(r.ent)}</td>
              <td className="num ins">{fmtNum(r.gak_ent)}</td>
              <td className="num"><span className="hud-rt-cov">{pct(r.ent_pct)}</span></td>
              <td className="num center"><GakRank rank={r.rank_ppl} /></td>
              <td className="num strong">{fmtNum(r.ppl)}</td>
              <td className="num ins">{fmtNum(r.gak_ppl)}</td>
              <td className="num"><span className="hud-rt-cov">{pct(r.ppl_pct)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Разбивка по размеру предприятия: линия показывает ПРОЦЕНТ застрахованных
function HudSizeBreakdown({ items }) {
  return (
    <div className="hud-size">
      {items.map((it, i) => {
        const tot = it.total || 0
        const ins = it.insured || 0
        const cov = tot ? Math.round((ins / tot) * 100) : 0
        return (
          <div className="hud-size-row" key={it.label + i}>
            <div className="hud-size-head">
              <span className="hud-size-label">{it.label}</span>
              <span className="hud-size-tot">застрах. <b>{fmtNum(ins)}</b></span>
            </div>
            <div className="hud-size-track" title={`Застраховано ${fmtNum(ins)} из ${fmtNum(tot)} (${cov}%)`}>
              <span className="hud-size-bar hud-size-pct" style={{ width: `${cov}%`, '--d': `${i * 60}ms` }} />
              <span className="hud-size-pctlabel">{cov}%</span>
            </div>
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

// Активность заходов по регионам за месяц (гит-календарь)
function HudActivity({ geo = {} }) {
  const [data, setData] = useState(null)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (m, g) => {
    const [y, mo] = (m || '').split('-')
    if (!y || !mo) return
    setLoading(true)
    try {
      // районов в журнале входов нет — фильтруется только по области
      const params = { year: Number(y), month: Number(mo) }
      if (g?.region) params.region = g.region
      const res = await api.get('/api/logs/heatmap', { params })
      setData(res.data)
    } catch { setData(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(month, geo) }, [month, geo, load])

  return (
    <HudCard id="sec-activity" wide>
      <div className="hud-activity-bar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="hud-month" />
      </div>
      {loading && !data ? (
        <div className="hud-act-empty">Загрузка…</div>
      ) : !data || data.regions.length === 0 ? (
        <div className="hud-act-empty">Нет заходов за выбранный месяц</div>
      ) : (
        <div className="hud-heatmap">
          <div className="hud-hm-row hud-hm-head">
            <span className="hud-hm-region" />
            <div className="hud-hm-days" />
            <span className="hud-hm-tot hud-hm-tothead">чел · заходов</span>
          </div>
          {data.regions.map((r) => {
            const maxv = Math.max(1, ...r.days)
            return (
              <div className="hud-hm-row" key={r.region}>
                <span className="hud-hm-region" title={r.region}>{r.region}</span>
                <div className="hud-hm-days">
                  {r.days.map((c, di) => {
                    const u = (r.users && r.users[di]) || 0
                    return (
                      <div className="hud-hm-day" key={di}>
                        <span className="hud-hm-daynum">{di + 1}</span>
                        <span className={'hud-hm-cell' + (c > 0 ? ' on' : '')}
                          title={`${di + 1} число: ${u} ${plural(u, 'учётка', 'учётки', 'учёток')}, ${c} ${plural(c, 'заход', 'захода', 'заходов')}`}
                          style={c > 0 ? { '--lvl': Math.min(1, 0.3 + 0.7 * (c / maxv)) } : undefined}>
                          {c > 0 ? <><span className="hud-hm-u">{u}</span><span className="hud-hm-c">{c}</span></> : ''}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <span className="hud-hm-tot"><b>{r.total_users}</b> чел · <b>{r.total}</b></span>
              </div>
            )
          })}
        </div>
      )}
    </HudCard>
  )
}

// Карта окончаний страховки: регионы × 12 месяцев, клик по ячейке → список предприятий
const MONTHS_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']
const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const fmtDate = (s) => {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d)) return s
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}
const bin12 = (b) => (b == null ? '' : String(b).padStart(12, '0'))

// Открыть предприятие в разделе «Страхование» (там — таблица только с ним).
// Переключение делает Dashboard.jsx по событию open-bin.
const openBinInInsurance = (bin) => {
  if (bin == null || bin === '') return
  window.dispatchEvent(new CustomEvent('open-bin', { detail: bin }))
}
const ROW_LINK_TITLE = 'Открыть в разделе «Страхование»'

const fmtDT = (s) => (s
  ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—')

// Универсальное окно «список предприятий» для провалов из карточек дашборда.
// load() → Promise<{items, limited?}>; columns: [{key, label, mono?, render?}]
function HudListModal({ title, subtitle, load, columns, onClose }) {
  const [items, setItems] = useState(null)
  const [limited, setLimited] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    load()
      .then((d) => { if (alive) { setItems(d.items || []); setLimited(!!d.limited) } })
      .catch((e) => { if (alive) { setErr(e.response?.data?.detail || 'Не удалось загрузить список'); setItems([]) } })
    return () => { alive = false }
  }, [])   // загрузка один раз при открытии

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="hud-portal">
    <div className="hud-modal-overlay" onClick={onClose}>
      <div className="hud-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hud-modal-head">
          <div>
            <div className="hud-modal-title">{title}</div>
            <div className="hud-modal-sub">
              {subtitle}
              {items && !err && <> · предприятий: <b>{fmtNum(items.length)}</b>{limited ? ' (показаны первые 1000)' : ''}</>}
            </div>
          </div>
          <button className="hud-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="hud-modal-body">
          {items === null ? (
            <div className="hud-act-empty">Загрузка…</div>
          ) : err ? (
            <div className="hud-act-empty">{err}</div>
          ) : items.length === 0 ? (
            <div className="hud-act-empty">Нет предприятий</div>
          ) : (
            <table className="hud-modal-table">
              <thead>
                <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className={it.bin ? 'hud-row-link' : undefined} title={it.bin ? ROW_LINK_TITLE : undefined}
                    onClick={it.bin ? () => { onClose(); openBinInInsurance(it.bin) } : undefined}>
                    {columns.map((c) => {
                      const v = c.render ? c.render(it) : it[c.key]
                      return (
                        <td key={c.key} className={c.mono ? 'mono' : ''}>
                          {v == null || v === '' ? '—' : v}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
    </div>,
    document.body,
  )
}

// Календарь: встречи КГИТ с прошедшей датой, по которым не обновлён итог.
// Клик по дню — список предприятий (с областью); «Всего» — за всё время.
const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const OVERDUE_COLUMNS = [
  { key: 'bin', label: 'БИН', mono: true },
  { key: 'bin_name', label: 'Предприятие' },
  { key: 'region', label: 'Область' },
  { key: 'kgit_status', label: 'Статус КГИТ' },
  { key: 'kgit_date', label: 'Дата встречи', mono: true,
    render: (it) => (it.kgit_date ? fmtDate(it.kgit_date) + (it.kgit_time ? ` ${it.kgit_time}` : '') : '—') },
  { key: 'meeting_status', label: 'Итог (не обновлён)',
    render: (it) => (it.meeting_status ? `${it.meeting_status}${it.meeting_date ? ` (${fmtDate(it.meeting_date)})` : ''}` : '— нет —') },
  { key: 'days_overdue', label: 'Просрочено', mono: true,
    render: (it) => (it.days_overdue != null ? `${it.days_overdue} ${plural(it.days_overdue, 'день', 'дня', 'дней')}` : '—') },
]

function HudOverdueCalendar({ geo = {} }) {
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [region, setRegion] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [drill, setDrill] = useState(null)   // {day} | {all: true}

  // Фильтр дашборда (область/район) важнее своего выбора области в блоке
  const geoOn = !!(geo.region || geo.district)
  const scopeParams = (reg) => {
    const p = {}
    if (geo.region) p.region = geo.region
    else if (!geoOn && reg) p.region = reg
    if (geo.district) p.district = geo.district
    return p
  }
  const scopeLabel = geo.district ? `${geo.region ? geo.region + ' · ' : ''}${geo.district}`
    : (geo.region || region || 'Все регионы')
  const load = useCallback(async (m, reg) => {
    const [y, mo] = (m || '').split('-')
    if (!y || !mo) return
    setLoading(true)
    try {
      const params = { year: Number(y), month: Number(mo), ...scopeParams(reg) }
      const res = await api.get('/api/dashboard/overdue-meetings', { params })
      setData(res.data)
    } catch { setData(null) } finally { setLoading(false) }
  }, [geo])
  useEffect(() => { load(month, region) }, [month, region, load])

  const [y, mo] = month.split('-').map(Number)
  const cells = []
  if (data) {
    for (let i = 0; i < data.first_weekday; i++) cells.push(null)
    for (let d = 1; d <= data.days_in_month; d++) cells.push(d)
  }
  const isoOf = (d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  const openList = (drillSpec) => {
    const params = scopeParams(region)
    if (!drillSpec.all) { params.year = y; params.month = mo; params.day = drillSpec.day }
    return api.get('/api/dashboard/overdue-meetings/list', { params }).then((r) => r.data)
  }

  return (
    <HudCard id="sec-overdue" title="Итог не обновлён после встречи" wide>
      <div className="hud-activity-bar">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="hud-month" />
        {!geoOn && (
          <select className="hud-month" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Все регионы</option>
            {(data?.regions || []).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        {data && (
          <>
            <span className="hud-od-sum">За месяц: <b>{fmtNum(data.total_month)}</b></span>
            <button type="button" className="hud-export-btn" disabled={!data.total_all}
              onClick={() => setDrill({ all: true })}>
              Всего просрочено: <b>{fmtNum(data.total_all)}</b>
            </button>
          </>
        )}
      </div>
      {loading && !data ? (
        <div className="hud-act-empty">Загрузка…</div>
      ) : !data ? (
        <div className="hud-act-empty">Нет данных</div>
      ) : (
        <div className="hud-od-cal">
          {WEEKDAYS_SHORT.map((w) => <div key={w} className="hud-od-wd">{w}</div>)}
          {cells.map((d, i) => {
            if (d == null) return <div key={`b${i}`} className="hud-od-blank" />
            const c = data.days[d] || 0
            const iso = isoOf(d)
            const cls = 'hud-od-day' + (c > 0 ? ' hot' : '') + (iso === data.today ? ' today' : '')
              + (iso > data.today ? ' future' : '')
            return (
              <button type="button" key={d} className={cls} disabled={!c}
                title={c ? `${d} ${MONTHS_FULL[mo - 1].toLowerCase()}: ${c} ${plural(c, 'встреча', 'встречи', 'встреч')} без итога` : undefined}
                onClick={() => c && setDrill({ day: d })}>
                <span className="hud-od-num">{d}</span>
                {c > 0 && <span className="hud-od-count">{fmtNum(c)}</span>}
              </button>
            )
          })}
        </div>
      )}
      {drill && (
        <HudListModal
          title={drill.all ? 'Итог не обновлён — все просроченные встречи'
            : `Итог не обновлён — встречи ${drill.day} ${MONTHS_FULL[mo - 1].toLowerCase()} ${y}`}
          subtitle={scopeLabel}
          load={() => openList(drill)}
          columns={OVERDUE_COLUMNS}
          onClose={() => setDrill(null)}
        />
      )}
    </HudCard>
  )
}

// Столбцы окна «кто стоит за ячейкой Активности статусов»
const ACTIVITY_LIST_COLUMNS = [
  { key: 'bin', label: 'БИН', mono: true },
  { key: 'bin_name', label: 'Предприятие' },
  { key: 'region', label: 'Область' },
  { key: 'detail', label: 'Статус' },
  { key: 'by', label: 'Кто поставил' },
  { key: 'at', label: 'Когда', mono: true, render: (it) => fmtDT(it.at) },
]

function HudExpiryModal({ year, month, region, district, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const pageSize = 50

  useEffect(() => {
    let alive = true
    setLoading(true)
    const params = { year, month, region, page, page_size: pageSize }
    if (district) params.district = district
    api.get('/api/dashboard/expiry-list', { params })
      .then((res) => { if (alive) setData(res.data) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [year, month, region, district, page])

  const total = data?.total || 0
  const pages = Math.max(1, Math.ceil(total / pageSize))

  return createPortal(
    <div className="hud-portal">
    <div className="hud-modal-overlay" onClick={onClose}>
      <div className="hud-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hud-modal-head">
          <div>
            <div className="hud-modal-title">Окончание страховки — {MONTHS_FULL[month - 1]} {year}</div>
            <div className="hud-modal-sub">{district ? `${region} · ${district}` : region} · предприятий: <b>{fmtNum(total)}</b></div>
          </div>
          <button className="hud-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="hud-modal-body">
          {loading && !data ? (
            <div className="hud-act-empty">Загрузка…</div>
          ) : total === 0 ? (
            <div className="hud-act-empty">Нет предприятий</div>
          ) : (
            <table className="hud-modal-table">
              <thead>
                <tr>
                  <th>БИН</th><th>Название компании</th><th>Страховая компания</th>
                  <th>Окончание</th><th>Телефон</th><th>Руководитель</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id} className="hud-row-link" title={ROW_LINK_TITLE}
                    onClick={() => { onClose(); openBinInInsurance(it.bin) }}>
                    <td className="mono">{bin12(it.bin)}</td>
                    <td title={it.bin_name}>{it.bin_name || '—'}</td>
                    <td title={it.system_delimiter_bin_name}>{it.system_delimiter_bin_name || '—'}</td>
                    <td className="mono">{fmtDate(it.date_end)}</td>
                    <td className="mono">{it.phone || '—'}</td>
                    <td>{[it.leader_surname, it.leader_name, it.leader_middlename].filter(Boolean).join(' ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {pages > 1 && (
          <div className="hud-modal-foot">
            <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Назад</button>
            <span>Стр. {page} из {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Вперёд →</button>
          </div>
        )}
      </div>
    </div>
    </div>,
    document.body,
  )
}

function HudExpiry({ geo = {} }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState(null) // {region, month}

  const load = useCallback(async (y, g) => {
    setLoading(true)
    try {
      const res = await api.get('/api/dashboard/expiry-heatmap', { params: { year: Number(y), ...g } })
      setData(res.data)
    } catch { setData(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(year, geo) }, [year, geo, load])

  const years = []
  for (let y = now.getFullYear() + 1; y >= now.getFullYear() - 4; y--) years.push(y)

  return (
    <HudCard id="sec-expiry" title="Окончание страховки по месяцам" wide>
      <div className="hud-activity-bar">
        <select className="hud-month" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y} год</option>)}
        </select>
      </div>
      {loading && !data ? (
        <div className="hud-act-empty">Загрузка…</div>
      ) : !data || data.regions.length === 0 ? (
        <div className="hud-act-empty">Нет данных за выбранный год</div>
      ) : (
        <div className="hud-heatmap">
          {data.regions.map((r) => {
            const maxv = Math.max(1, ...r.months)
            return (
              <div className={'hud-hm-row hud-exp-row' + (r.is_total ? ' hud-row-total' : '')} key={r.region}>
                <span className="hud-hm-region" title={r.region}>{r.region}</span>
                <div className="hud-hm-days">
                  {r.months.map((c, mi) => (
                    <div className="hud-hm-day" key={mi}>
                      <span className="hud-hm-daynum">{MONTHS_SHORT[mi]}</span>
                      <button
                        type="button"
                        className={'hud-hm-cell hud-exp-cell' + (c > 0 ? ' on' : '')}
                        disabled={c === 0}
                        title={`${MONTHS_FULL[mi]} ${data.year}: ${c} ${plural(c, 'предприятие', 'предприятия', 'предприятий')}`}
                        onClick={() => c > 0 && setSel(data.geo_level === 'district' && !r.is_total
                          ? { region: data.geo_region, district: r.region, month: mi + 1 }
                          : { region: r.region, month: mi + 1 })}
                        style={c > 0 ? { '--lvl': Math.min(1, 0.3 + 0.7 * (c / maxv)) } : undefined}>
                        {c > 0 ? fmtNum(c) : ''}
                      </button>
                    </div>
                  ))}
                </div>
                <span className="hud-hm-tot"><b>{fmtNum(r.total)}</b> за год</span>
              </div>
            )
          })}
        </div>
      )}
      {sel && (
        <HudExpiryModal year={data.year} month={sel.month} region={sel.region} district={sel.district} onClose={() => setSel(null)} />
      )}
    </HudCard>
  )
}

// Режимы для рейтинга и активности статусов: какой из трёх столбцов показывать
const STATUS_MODES = [
  { key: 'status',         label: 'Статус ГАК' },
  { key: 'kgit_status',    label: 'Статус КГИТ' },
  { key: 'meeting_status', label: 'Статус встречи' },
]
function HudStatusTabs({ value, onChange }) {
  return (
    <div className="hud-tabs" role="tablist">
      {STATUS_MODES.map((m) => (
        <button key={m.key} type="button" role="tab" aria-selected={value === m.key}
          className={'hud-tab-btn' + (value === m.key ? ' active' : '')}
          onClick={() => onChange(m.key)}>
          {m.label}
        </button>
      ))}
    </div>
  )
}

// Рейтинг статусов с переключением столбца (по умолчанию — Статус ГАК)
function HudStatusRanking({ ins }) {
  const [mode, setMode] = useState('status')
  const items = mode === 'kgit_status' ? (ins.by_status_kgit || [])
    : mode === 'meeting_status' ? (ins.by_status_meeting || [])
    : (ins.by_status || [])
  return (
    <HudCard id="sec-status-rank" title="Рейтинг статусов" wide>
      <div className="hud-activity-bar"><HudStatusTabs value={mode} onChange={setMode} /></div>
      {items.length === 0
        ? <div className="hud-act-empty">Нет проставленных статусов</div>
        : <HudRanking items={items} color="var(--h-blue)" />}
    </HudCard>
  )
}

// Активность статусов: по статусам (Y) × дни месяца, фильтры месяц + регион
function HudStatusActivity({ geo = {} }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [region, setRegion] = useState('')
  const [mode, setMode] = useState('status')   // по умолчанию — Статус ГАК
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  // Фильтр дашборда (область/район) важнее своего выбора области в блоке
  const geoOn = !!(geo.region || geo.district)
  const scopeParams = (reg) => {
    const p = {}
    if (geo.region) p.region = geo.region
    else if (!geoOn && reg) p.region = reg
    if (geo.district) p.district = geo.district
    return p
  }
  const scopeLabel = geo.district ? `${geo.region ? geo.region + ' · ' : ''}${geo.district}`
    : (geo.region || region || 'все регионы')
  const load = useCallback(async (m, reg, field) => {
    const [y, mo] = (m || '').split('-')
    if (!y || !mo) return
    setLoading(true)
    try {
      const params = { year: Number(y), month: Number(mo), field, ...scopeParams(reg) }
      const res = await api.get('/api/dashboard/status-activity', { params })
      setData(res.data)
    } catch { setData(null) } finally { setLoading(false) }
  }, [geo])
  useEffect(() => { load(month, region, mode) }, [month, region, mode, load])

  const regions = data?.regions || []
  const rows = (data?.statuses || []).filter((s) => s.total > 0)
  const dim = data?.days_in_month || 0
  const dayTotals = Array.from({ length: dim }, (_, di) => rows.reduce((s, r) => s + (r.days[di] || 0), 0))
  const grandTotal = rows.reduce((s, r) => s + r.total, 0)

  // Провал в ячейку: {status?, day?} — список предприятий за ней
  const [drill, setDrill] = useState(null)
  const modeLabel = (STATUS_MODES.find((m) => m.key === mode) || {}).label
  const [ay, amo] = (month || '').split('-').map(Number)
  const openActivityList = (spec) => {
    const params = { year: ay, month: amo, field: mode }
    if (spec.day) params.day = spec.day
    if (spec.status) params.status = spec.status
    Object.assign(params, scopeParams(region))
    return api.get('/api/dashboard/status-activity/list', { params }).then((r) => r.data)
  }

  // Excel за выбранный месяц: 3 листа (ГАК / КГИТ / встречи), регионы × статусы
  const [exporting, setExporting] = useState(false)
  const exportExcel = async () => {
    const [y, mo] = (month || '').split('-')
    if (!y || !mo) return
    setExporting(true)
    try {
      const res = await api.get('/api/dashboard/status-activity/export', {
        params: { year: Number(y), month: Number(mo), ...scopeParams(region) }, responseType: 'blob',
      })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.setAttribute('download', `Активность_статусов_${y}_${mo}.xlsx`)
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      alert('Не удалось сформировать Excel')
    } finally {
      setExporting(false)
    }
  }

  return (
    <HudCard id="sec-status-act" title="Активность статусов" wide>
      <div className="hud-activity-bar">
        <HudStatusTabs value={mode} onChange={setMode} />
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="hud-month" />
        {!geoOn && (
          <select className="hud-month" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">Все регионы</option>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        <button type="button" className="hud-export-btn" onClick={exportExcel} disabled={exporting}
          title="Excel за выбранный месяц: листы «Статус ГАК», «Статус КГИТ», «Статус встречи» (регионы × статусы)">
          <Download size={15} /> {exporting ? 'Формирую…' : 'Скачать Excel'}
        </button>
      </div>
      {loading && !data ? (
        <div className="hud-act-empty">Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className="hud-act-empty">Нет проставленных статусов за выбранный месяц</div>
      ) : (
        <div className="hud-heatmap">
          {rows.map((r) => {
            const maxv = Math.max(1, ...r.days)
            return (
              <div className="hud-hm-row hud-stat-row" key={r.status}>
                <span className="hud-hm-region" title={r.status}>{r.status}</span>
                <div className="hud-hm-days">
                  {r.days.map((c, di) => (
                    <div className="hud-hm-day" key={di}>
                      <span className="hud-hm-daynum">{di + 1}</span>
                      <span className={'hud-hm-cell' + (c > 0 ? ' on click' : '')}
                        title={`${di + 1} число: ${c} ${plural(c, 'статус', 'статуса', 'статусов')}${c > 0 ? ' — нажмите, чтобы посмотреть предприятия' : ''}`}
                        style={c > 0 ? { '--lvl': Math.min(1, 0.3 + 0.7 * (c / maxv)) } : undefined}
                        onClick={() => c > 0 && setDrill({ status: r.status, day: di + 1 })}>
                        {c > 0 ? fmtNum(c) : ''}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="hud-hm-tot click" title="Предприятия за месяц"
                  onClick={() => setDrill({ status: r.status })}><b>{fmtNum(r.total)}</b> за месяц</span>
              </div>
            )
          })}
          {/* Итоговая строка: сумма по дням и за месяц */}
          {(() => {
            const maxv = Math.max(1, ...dayTotals)
            return (
              <div className="hud-hm-row hud-stat-row hud-stat-total">
                <span className="hud-hm-region">Итого</span>
                <div className="hud-hm-days">
                  {dayTotals.map((c, di) => (
                    <div className="hud-hm-day" key={di}>
                      <span className="hud-hm-daynum">{di + 1}</span>
                      <span className={'hud-hm-cell' + (c > 0 ? ' on click' : '')}
                        title={`${di + 1} число: ${c} ${plural(c, 'статус', 'статуса', 'статусов')}${c > 0 ? ' — нажмите, чтобы посмотреть предприятия' : ''}`}
                        style={c > 0 ? { '--lvl': Math.min(1, 0.3 + 0.7 * (c / maxv)) } : undefined}
                        onClick={() => c > 0 && setDrill({ day: di + 1 })}>
                        {c > 0 ? fmtNum(c) : ''}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="hud-hm-tot click" title="Все предприятия за месяц"
                  onClick={() => setDrill({})}><b>{fmtNum(grandTotal)}</b> за месяц</span>
              </div>
            )
          })()}
        </div>
      )}
      {drill && (
        <HudListModal
          title={`Активность — ${modeLabel}: ${drill.status || 'все статусы'}`}
          subtitle={`${drill.day ? `${drill.day} ` : ''}${(MONTHS_FULL[amo - 1] || '').toLowerCase()} ${ay} · ${scopeLabel}`}
          load={() => openActivityList(drill)}
          columns={ACTIVITY_LIST_COLUMNS}
          onClose={() => setDrill(null)}
        />
      )}
    </HudCard>
  )
}

// Закреплённая справа навигация по разделам дашборда (скролл к секции).
// Рендерится порталом в body: иначе трансформированный предок (анимация
// перехода в дашборд) делает position:fixed относительным и меню уезжает.
function HudNav({ items, open, setOpen }) {
  const [active, setActive] = useState(items[0]?.id)
  const navRef = React.useRef(null)

  useEffect(() => {
    const ids = items.map((i) => i.id)
    const onScroll = () => {
      let cur = ids[0]
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top <= 160) cur = id
      }
      setActive(cur)
      // Панель держится под шапкой: пока шапка на экране — начинается под ней,
      // когда шапка уехала вверх — поднимается к верху окна. Шапку не перекрывает.
      // (если есть полоса демо-режима — она прилипает к верху окна, держимся под ней)
      const hdr = document.querySelector('.demo-bar') || document.querySelector('.dashboard-header')
      const top = Math.max(16, (hdr ? hdr.getBoundingClientRect().bottom : 0) + 16)
      if (navRef.current) navRef.current.style.setProperty('--nav-top', `${Math.round(top)}px`)
    }
    // Скроллиться может как окно, так и внутренний контейнер контента
    const sc = document.querySelector('.content') || document.querySelector('.main-content')
    if (sc) sc.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    onScroll()
    return () => {
      if (sc) sc.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [items])

  // Активный пункт держим в видимой части списка
  useEffect(() => {
    const el = navRef.current?.querySelector('.hud-nav-link.active')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const go = (id) => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const activeIdx = Math.max(0, items.findIndex((i) => i.id === active))

  return createPortal(
    <nav ref={navRef} className={'hud-nav' + (open ? ' open' : ' collapsed')} aria-label="Разделы дашборда">
      <div className="hud-nav-head">
        {open && (
          <span className="hud-nav-title">
            <ListTree size={15} /> Разделы
            <i>{activeIdx + 1} / {items.length}</i>
          </span>
        )}
        <button type="button" className="hud-nav-toggle" onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Свернуть меню разделов' : 'Развернуть меню разделов'}
          title={open ? 'Свернуть' : 'Разделы'}>
          {open ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
      <ul className="hud-nav-list">
        {items.map((it, i) => (
          <li key={it.id}>
            <button type="button" onClick={() => go(it.id)} title={open ? undefined : it.label}
              className={'hud-nav-link' + (active === it.id ? ' active' : '') + (i < activeIdx ? ' passed' : '')}>
              <span className="hud-nav-num">{i + 1}</span>
              {open && <span className="hud-nav-text">{it.label}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>,
    document.body,
  )
}

// ─── Рейтинг страховых компаний с фильтром по периоду ───────────────────────
// Без периода — действующие договоры на сегодня (данные из общего запроса
// дашборда). С периодом — договоры, НАЧАВШИЕСЯ в эти даты («Дата начала»),
// включая уже закончившиеся: сколько предприятий / людей застраховано за период.
function HudInsurerRanking({ id, title, mode, initial, color, geo = {} }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState(null)      // null — период не задан
  const [loading, setLoading] = useState(false)
  const active = !!(from || to)

  useEffect(() => {
    if (!from && !to) { setData(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    // небольшая задержка: дату часто набирают с клавиатуры по цифре
    const t = setTimeout(() => {
      const params = { mode, ...geo }
      if (from) params.date_from = from
      if (to) params.date_to = to
      api.get('/api/dashboard/insurer-ranking', { params })
        .then((r) => { if (!cancelled) setData(r.data) })
        .catch(() => { if (!cancelled) setData({ items: [], total: 0 }) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [from, to, mode, geo])

  const items = withShortNames(data ? data.items : initial)
  const unit = mode === 'people' ? 'чел.' : 'предприятий'

  return (
    <HudCard id={id} title={title} wide>
      <div className="hud-activity-bar hud-period-bar">
        <span className="hud-period-label">Начало договора</span>
        <label className="hud-period-field">с
          <input type="date" className="hud-month" value={from} max={to || undefined}
            onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="hud-period-field">по
          <input type="date" className="hud-month" value={to} min={from || undefined}
            onChange={(e) => setTo(e.target.value)} />
        </label>
        {active && (
          <button type="button" className="hud-clear-btn" onClick={() => { setFrom(''); setTo('') }}>
            Сбросить
          </button>
        )}
        <span className="hud-od-sum">
          {!active ? 'Действующие договоры на сегодня'
            : loading || !data ? 'Считаем…'
            : <>Застраховано за период: <b>{fmtNum(data.total)}</b> {unit}</>}
        </span>
      </div>
      {mode === 'enterprises' && (
        <div className="hud-size-legend">
          {SIZE_PARTS.map((p) => <span key={p.key} className={'hud-sz ' + p.cls}><i />{p.label}</span>)}
          {/* «не указан» — только если такие предприятия действительно есть */}
          {items.some((it) => it.sizes && restOf(it) > 0) && <span className="hud-sz rest"><i />размер не указан</span>}
        </div>
      )}
      {active && !loading && data && items.length === 0 ? (
        <div className="hud-act-empty">Договоров, начавшихся в этот период, нет</div>
      ) : (
        <div className={loading ? 'hud-dim' : undefined}>
          <HudRanking items={items} color={color} />
        </div>
      )}
    </HudCard>
  )
}

// ─── Основной компонент ──────────────────────────────────────────────────────
const DashboardHud = () => {
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  // Фильтр дашборда: область и район — то же, что смотреть дашборд от лица
  // регионального аккаунта. Региональному аккаунту доступны только его области.
  const [geo, setGeo] = useState({ region: '', district: '' })
  const [geoRegions, setGeoRegions] = useState([])
  const [geoDistricts, setGeoDistricts] = useState([])
  useEffect(() => {
    api.get('/api/regions').then((r) => setGeoRegions(r.data || [])).catch(() => {})
  }, [])
  // область, по которой выбираются районы: выбранная или единственная доступная
  const districtRegion = geo.region || (user?.region && geoRegions.length === 1 ? geoRegions[0] : '')
  useEffect(() => {
    if (!districtRegion) { setGeoDistricts([]); return }
    api.get('/api/districts', { params: { region: districtRegion } })
      .then((r) => setGeoDistricts(r.data || [])).catch(() => setGeoDistricts([]))
  }, [districtRegion])
  const geoParams = useMemo(() => {
    const p = {}
    if (geo.region) p.region = geo.region
    if (geo.district) p.district = geo.district
    return p
  }, [geo])

  const load = useCallback(async (params) => {
    setLoading(true)
    try {
      const res = await api.get('/api/dashboard/kpis', { params })
      setData(res.data)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(geoParams) }, [geoParams, load])

  // Боковое меню разделов: развёрнуто / свёрнуто (помним выбор; на узком экране
  // по умолчанию свёрнуто). Под меню у страницы резервируется место справа.
  const [navOpen, setNavOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('hudNavOpen')
      if (saved != null) return saved === '1'
      return window.innerWidth > 1280
    } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('hudNavOpen', navOpen ? '1' : '0') } catch {} }, [navOpen])

  if (loading && !data) {
    return (
      <div className="hud-view">
        <div className="hud-loading">
          <ThinkingOrb className="hud-orb" state="searching" size={64} theme="dark" aria-label="Загрузка" />
        </div>
      </div>
    )
  }
  if (!data) {
    return <div className="hud-view"><div className="hud-loading">Нет данных</div></div>
  }

  const ins = data.insurance
  // региональный пользователь — разбивки по районам его области
  const byDistrict = ins.geo_level === 'district'
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

  // В меню — каждая таблица/график отдельно (без KPI-панелей)
  const navItems = [
    ...(ins.region_table?.length ? [{ id: 'sec-region', label: byDistrict ? 'Страхование по районам' : 'Страхование по регионам' }] : []),
    ...(ins.gak_rating?.length ? [{ id: 'sec-gak', label: 'Рейтинг ГАКа' }] : []),
    { id: 'sec-expiry', label: 'Окончание страховки' },
    { id: 'sec-form', label: 'Форма предприятия' },
    ...(ins.by_insurer?.length ? [{ id: 'sec-insurer', label: 'Рейтинг страховых компаний' }] : []),
    ...(ins.by_insurer_emp?.length ? [{ id: 'sec-insurer-emp', label: 'Рейтинг страховых по людям' }] : []),
    ...(ins.by_size?.length ? [{ id: 'sec-size', label: 'Размер предприятия' }] : []),
    ...((ins.by_status?.length || ins.by_status_kgit?.length || ins.by_status_meeting?.length)
      ? [{ id: 'sec-status-rank', label: 'Рейтинг статусов' }] : []),
    { id: 'sec-status-act', label: 'Активность статусов' },
    { id: 'sec-overdue', label: 'Итог не обновлён после встречи' },
    ...(ins.status_fill?.length ? [{ id: 'sec-status-fill', label: byDistrict ? 'Заполненность статусов по районам' : 'Заполненность статусов по регионам' }] : []),
    ...(op ? [{ id: 'sec-oked', label: 'Рейтинг ОКЭД по сотрудникам' }] : []),
    { id: 'sec-activity', label: 'Активность заходов' },
  ]

  return (
    <div className={'hud-view has-nav ' + (navOpen ? 'nav-open' : 'nav-collapsed')}>
      <HudNav items={navItems} open={navOpen} setOpen={setNavOpen} />
      <div className="hud-topline">
        <div className="hud-topline-title">Аналитический дашборд</div>
      </div>

      {/* Фильтр по области и району */}
      <div className="hud-geo-bar">
        <label className="hud-period-field">Область
          <select className="hud-month" value={geo.region} disabled={!!user?.region && geoRegions.length <= 1}
            onChange={(e) => setGeo({ region: e.target.value, district: '' })}>
            {!(user?.region && geoRegions.length === 1) && (
              <option value="">{user?.region ? 'Все мои области' : 'Весь Казахстан'}</option>
            )}
            {geoRegions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="hud-period-field">Район
          <select className="hud-month" value={geo.district} disabled={!districtRegion}
            onChange={(e) => setGeo({ ...geo, district: e.target.value })}>
            <option value="">{districtRegion ? 'Все районы' : 'Сначала выберите область'}</option>
            {geoDistricts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        {(geo.region || geo.district) && (
          <button type="button" className="hud-clear-btn" onClick={() => setGeo({ region: '', district: '' })}>
            Сбросить
          </button>
        )}
        {loading && <span className="hud-od-sum">Обновляем…</span>}
      </div>

      <h2 className="hud-h2"><Shield size={18} /> Страхование</h2>
      <KpiPanel tiles={insTiles} cols={4} />
      {ins.region_table && ins.region_table.length > 0 && (
        <div className="hud-charts">
          <HudCard id="sec-region" title={byDistrict ? `Страхование по районам — ${ins.geo_region}${ins.scope?.district ? ' · ' + ins.scope.district : ''}` : 'Страхование по регионам'} wide>
            <HudRegionTable rows={ins.region_table} district={byDistrict} />
          </HudCard>
        </div>
      )}
      {ins.gak_rating && ins.gak_rating.length > 0 && (
        <div className="hud-charts">
          <HudCard id="sec-gak" title="Рейтинг ГАКа" wide>
            <GakExportButton geo={geoParams} />
            <HudGakTable rows={ins.gak_rating} district={byDistrict} />
          </HudCard>
        </div>
      )}
      <div className="hud-charts"><HudExpiry geo={geoParams} /></div>
      <div className="hud-charts">
        <HudCard id="sec-form" title="Форма предприятия" wide>
          <HudDonut a={ins.ul_cnt} b={ins.ip_cnt} labelA="ЮЛ" labelB="ИП" />
          <div className="hud-donut-extra">
            <div className="hud-donut-extra-title">Застрахованы</div>
            <div><i style={{ background: 'var(--h-cyan)' }} /> ЮЛ: <b>{fmtNum(ins.ul_ins)}</b> <span className="dim">из {fmtNum(ins.ul_cnt)}</span></div>
            <div><i style={{ background: 'var(--h-amber)' }} /> ИП: <b>{fmtNum(ins.ip_ins)}</b> <span className="dim">из {fmtNum(ins.ip_cnt)}</span></div>
          </div>
        </HudCard>
      </div>
      {ins.by_insurer && ins.by_insurer.length > 0 && (
        <div className="hud-charts">
          <HudInsurerRanking id="sec-insurer" mode="enterprises" initial={ins.by_insurer} color="var(--h-teal)" geo={geoParams}
            title="Рейтинг страховых компаний по застрахованным предприятиям" />
        </div>
      )}
      {ins.by_insurer_emp && ins.by_insurer_emp.length > 0 && (
        <div className="hud-charts">
          <HudInsurerRanking id="sec-insurer-emp" mode="people" initial={ins.by_insurer_emp} color="var(--h-cyan)" geo={geoParams}
            title="Рейтинг страховых компаний по застрахованным людям" />
        </div>
      )}
      {ins.by_size && ins.by_size.length > 0 && (
        <div className="hud-charts">
          <HudCard id="sec-size" title="Разбивка по размеру предприятия" wide>
            <HudSizeBreakdown items={ins.by_size} />
          </HudCard>
        </div>
      )}
      {(ins.by_status?.length || ins.by_status_kgit?.length || ins.by_status_meeting?.length) ? (
        <div className="hud-charts">
          <HudStatusRanking ins={ins} />
        </div>
      ) : null}
      <div className="hud-charts"><HudStatusActivity geo={geoParams} /></div>
      <div className="hud-charts"><HudOverdueCalendar geo={geoParams} /></div>
      {ins.status_fill && ins.status_fill.length > 0 && (
        <div className="hud-charts">
          <HudCard id="sec-status-fill" title={byDistrict ? 'Рейтинг районов по заполненности статусов' : 'Рейтинг регионов по заполненности статусов'} wide>
            <div className="hud-fill-note">{byDistrict ? 'Доля предприятий района, которым проставлен статус' : 'Доля незастрахованных предприятий региона, которым проставлен статус'}</div>
            <HudFillRanking rows={ins.status_fill} />
          </HudCard>
        </div>
      )}

      {op && (
        <>
          <h2 className="hud-h2"><Coins size={18} /> Анализ ОППВ
            {geo.district && <span className="hud-h2-note">по всей области — районов в данных ОППВ нет</span>}
          </h2>
          <KpiPanel tiles={opTiles} cols={3} />
          <div className="hud-charts">
            <HudCard id="sec-oked" title="Рейтинг ОКЭД по сотрудникам" wide>
              <HudRanking items={op.by_oked} color="var(--h-teal)" />
            </HudCard>
          </div>
        </>
      )}

      <h2 className="hud-h2"><Activity size={18} /> Активность</h2>
      <div className="hud-charts"><HudActivity geo={geoParams} /></div>
    </div>
  )
}

export default DashboardHud
