import React, { useRef, useState, useMemo, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'

// Мини-график в подложке плитки KPI (порт из projects/pm, адаптирован под plain JS):
// линия «прочерчивается» слева направо, по ней пробегает световая точка; столбцы
// вырастают волной. Слева график гасится маской (hud.css). Рисуется в реальных
// пикселях (ResizeObserver). Тултип — отдельным элементом в <body>.

const PAD = { top: 14, bottom: 8, left: 4, right: 8 }

function smoothPath(pts) {
  if (pts.length < 2) return ''
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2
    const t = 0.19
    d += ` C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t}` +
         ` ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`
  }
  return d
}

let uid = 0

// spark = { kind: 'line'|'bar', labels:[], values:[], format:(v)=>string, color }
export function KpiSpark({ spark, delay = 0 }) {
  const wrap = useRef(null)
  const [size, setSize] = useState(null)
  const [hover, setHover] = useState(null)
  const [tip, setTip] = useState(null)
  const id = useMemo(() => `ks${++uid}`, [])

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize((s) => (s && Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { kind, values, labels, color, format } = spark
  const sig = labels.join('|') + '#' + values.join('|')

  const geo = useMemo(() => {
    if (!size || size.w < 40 || size.h < 26 || !values.length) return null
    const { w, h } = size
    const iw = w - PAD.left - PAD.right, ih = h - PAD.top - PAD.bottom
    const max = Math.max(...values), min = kind === 'bar' ? 0 : Math.min(...values)
    const span = max - min || 1
    const y = (v) => PAD.top + ih - ((v - min) / span) * ih * (kind === 'bar' ? 1 : 0.88)
    if (kind === 'bar') {
      const step = iw / values.length
      const bw = Math.max(2, step * 0.66)
      return {
        w, h, step,
        bars: values.map((v, i) => {
          const top = y(v)
          return { x: PAD.left + i * step + (step - bw) / 2, y: top, w: bw, h: Math.max(1.5, PAD.top + ih - top), cx: PAD.left + i * step + step / 2 }
        }),
      }
    }
    const step = values.length > 1 ? iw / (values.length - 1) : 0
    const pts = values.map((v, i) => [PAD.left + i * step, y(v)])
    const line = smoothPath(pts)
    const area = line + ` L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`
    return { w, h, step, pts, line, area }
  }, [size, sig, kind])

  const onMove = (e) => {
    if (!geo || !wrap.current) return
    const r = wrap.current.getBoundingClientRect()
    const x = e.clientX - r.left - PAD.left
    const n = values.length
    const i = kind === 'bar' ? Math.floor(x / geo.step) : Math.round(x / (geo.step || 1))
    const k = Math.max(0, Math.min(n - 1, i))
    const px = kind === 'bar' ? geo.bars[k].cx : geo.pts[k][0]
    const py = kind === 'bar' ? geo.bars[k].y : geo.pts[k][1]
    setHover(k)
    setTip({ x: r.left + px, y: r.top + py })
  }
  const onLeave = () => { setHover(null); setTip(null) }

  return (
    <div ref={wrap} className="kpi-spark-wrap" onMouseMove={onMove} onMouseLeave={onLeave}
      style={{ '--spark': color, '--spark-delay': `${delay}ms` }} aria-hidden>
      {geo && (
        <svg key={sig} className={`kpi-spark kpi-spark-${kind}`} width={geo.w} height={geo.h}>
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`${id}-bar`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.95} />
              <stop offset="100%" stopColor={color} stopOpacity={0.25} />
            </linearGradient>
          </defs>
          {geo.line && (
            <>
              <path className="ks-area" d={geo.area} fill={`url(#${id}-fill)`} />
              <path className="ks-line" d={geo.line} pathLength={1} fill="none" stroke={color} strokeWidth={2} />
              {geo.pts.map(([x, y], i) => (geo.pts.length > 14 && hover !== i) ? null : (
                <circle key={i} className="ks-dot" cx={x} cy={y} r={hover === i ? 5.5 : 3}
                  fill={hover === i ? '#fff' : color} stroke={hover === i ? color : 'var(--hud-card)'} strokeWidth={2}
                  style={{ '--i': i, '--n': geo.pts.length }} />
              ))}
              <circle className="ks-runner" r={3.5} fill="#fff">
                <animateMotion dur="5.6s" repeatCount="indefinite" begin={`${1.6 + delay / 1000}s`} path={geo.line}
                  keyPoints="0;1;1" keyTimes="0;0.4;1" calcMode="linear" />
                <animate attributeName="opacity" dur="5.6s" repeatCount="indefinite" begin={`${1.6 + delay / 1000}s`}
                  values="0;1;1;0;0" keyTimes="0;0.04;0.36;0.42;1" />
              </circle>
            </>
          )}
          {geo.bars && geo.bars.map((b, i) => (
            <rect key={i} className="ks-bar" x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(3, b.w / 2)}
              fill={hover === i ? color : `url(#${id}-bar)`}
              style={{ '--i': i, '--n': geo.bars.length }} />
          ))}
        </svg>
      )}
      {hover !== null && tip && createPortal(
        <div className="hud-tip" style={{ left: tip.x, top: tip.y }}>
          <span className="hud-tip-t">{labels[hover]}</span>
          <span className="hud-tip-v">{format ? format(values[hover]) : values[hover]}</span>
        </div>,
        document.body,
      )}
    </div>
  )
}

// Плавный пересчёт числа при появлении (count-up).
export function CountUp({ value, format }) {
  const animate = value !== null && value !== undefined && Number.isFinite(value) &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if (!animate) return
    const start = from.current, t0 = performance.now(), dur = 1100
    let raf = 0
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)
      const v = start + (value - start) * e
      from.current = v
      setShown(p < 1 ? v : value)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, animate])
  return <>{format ? format(animate ? shown : value) : (animate ? shown : value)}</>
}
