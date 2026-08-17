import React, { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch, API } from './api'
import { showToast } from './toast'

export function VerifyView({ drawingId, projectId, symTypes: passedSymTypes, onNavigate }) {
  const [drawing,     setDrawing]    = useState(null)
  const [pages,       setPages]      = useState([])
  const [pageIdx,     setPageIdx]    = useState(0)
  const [image,       setImage]      = useState(null)
  const [detections,  setDetections] = useState({})   // { pageNum: [det, ...] }
  const [symTypes,    setSymTypes]   = useState(passedSymTypes || [])
  const [activeType,  setActiveType] = useState(null)
  const [selectedId,  setSelectedId] = useState(null)
  const [saving,      setSaving]     = useState(false)
  const [loadingPage, setLoadingPage] = useState(false)
  const [pageError,   setPageError]   = useState(null)   // string when the page image failed to load
  // Snip mode
  const [snipMode,    setSnipMode]   = useState(null)    // null | symbol_type_id
  const [snipRect,    setSnipRect]   = useState(null)
  const snipRectRef  = useRef(null)   // always-current mirror — read in mouseUp to avoid stale closure
  const snipStartRef = useRef(null)
  const [snipSaving,  setSnipSaving] = useState(false)
  // Context menu
  const [ctxMenu,     setCtxMenu]    = useState(null)    // {x,y,det,pn} | null
  // Door-ref editor
  const [doorRefEdit, setDoorRefEdit] = useState(null)   // {det, pn} | null
  const [doorRefValue, setDoorRefValue] = useState('')

  const canvasRef   = useRef()
  const wrapRef     = useRef()
  const zoomRef     = useRef(1)
  const panRef      = useRef({ x: 0, y: 0 })
  const panningRef  = useRef(false)
  const panStartRef = useRef({})
  const nextIdRef   = useRef(1)
  // Drag-to-move
  const draggingRef    = useRef(null)   // { id, origImgX, origImgY, startCx, startCy }
  const dragMovedRef   = useRef(false)  // true once mouse moved > threshold
  const dblClickRef    = useRef(false)  // suppress click-after-dblclick

  // ── Symbol setup wizard ───────────────────────────────────────────────────
  const [wizardShow,    setWizardShow]    = useState(false)
  const [wizardStep,    setWizardStep]    = useState(0)
  const [wizardPreview, setWizardPreview] = useState(null)  // { url } after snip
  const wizardDismissedRef = useRef(false)

  // ── Data load (also used by the detection poll) ───────────────────────────
  const applyPages = useCallback((ps, preserveManual = false) => {
    const detMap = {}
    ;(ps || []).forEach(p => {
      // IDs are assigned server-side; assign extra client IDs for any missing
      detMap[p.page_number] = (p.detections || []).map(det => ({
        ...det,
        id: det.id ?? nextIdRef.current++,
      }))
    })
    let maxId = 0
    Object.values(detMap).forEach(dets => dets.forEach(d => { if ((d.id || 0) > maxId) maxId = d.id }))
    // Markers the user placed while detection was still running survive the refresh
    if (preserveManual) {
      Object.entries(detectionsRef.current || {}).forEach(([pn, dets]) => {
        dets.filter(d => d.method === 'manual').forEach(d => {
          detMap[pn] = [...(detMap[pn] || []), { ...d, id: ++maxId }]
        })
      })
    }
    nextIdRef.current = maxId + 1
    setPages(ps || [])
    setDetections(detMap)
  }, [])

  const detectionsRef = useRef({})
  useEffect(() => { detectionsRef.current = detections }, [detections])

  useEffect(() => {
    Promise.all([
      apiFetch(`/drawings/${drawingId}`),
      apiFetch(`/drawings/${drawingId}/pages`),
      symTypes.length ? Promise.resolve(symTypes) : apiFetch(`/projects/${projectId}/symbol-types`),
    ]).then(([d, ps, st]) => {
      setDrawing(d)
      applyPages(ps)
      const types = st || []
      setSymTypes(types)
      if (types.length > 0) setActiveType(types[0].code)
    }).catch(err => showToast(err.message, 'error'))
  }, [drawingId])

  // ── Detection poll ────────────────────────────────────────────────────────
  // While the background task runs, pages render immediately and markers
  // arrive when detection finishes — no manual refresh needed.
  useEffect(() => {
    if (!drawing || !['uploaded', 'processing'].includes(drawing.status)) return
    const t = setInterval(async () => {
      try {
        const d = await apiFetch(`/drawings/${drawingId}`)
        if (!d) return
        if (pagesRef.current.length === 0) {
          const ps = await apiFetch(`/drawings/${drawingId}/pages`)
          if (ps && ps.length) applyPages(ps, true)
        }
        if (d.status !== drawing.status) {
          setDrawing(d)
          if (['detected', 'error'].includes(d.status)) {
            const ps = await apiFetch(`/drawings/${drawingId}/pages`)
            applyPages(ps, true)
            if (d.status === 'detected') showToast('Detection finished — markers loaded', 'success')
          }
        }
      } catch { /* transient poll failure — next tick retries */ }
    }, 3500)
    return () => clearInterval(t)
  }, [drawing?.status, drawingId])

  const pagesRef = useRef([])
  useEffect(() => { pagesRef.current = pages }, [pages])

  const curPage = pages[pageIdx]
  const curDets = detections[curPage?.page_number] || []

  // ── Page image load (authenticated fetch → blob → img) ───────────────────
  useEffect(() => {
    if (!curPage) return
    setLoadingPage(true)
    setImage(null)
    setPageError(null)

    const token = localStorage.getItem('token')
    fetch(curPage.image_url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => {
        if (!r.ok) throw new Error(`server responded ${r.status} ${r.statusText} for ${curPage.image_url}`)
        return r.blob()
      })
      .then(blob => {
        const url = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          setImage(img)
          setLoadingPage(false)
          URL.revokeObjectURL(url)
        }
        img.onerror = () => {
          setLoadingPage(false)
          setPageError('the image file is corrupt or unreadable')
          URL.revokeObjectURL(url)
        }
        img.src = url
      })
      .catch(err => {
        setLoadingPage(false)
        setPageError(err.message)
      })
  }, [curPage?.page_number, curPage?.image_url])

  // ── Canvas setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap   = wrapRef.current
    if (!canvas || !wrap) return
    const ro = new ResizeObserver(() => {
      canvas.width  = wrap.clientWidth
      canvas.height = wrap.clientHeight
      redraw()
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, []) // eslint-disable-line

  // Show wizard on first image load when any symbol type has no templates
  useEffect(() => {
    if (!image || wizardDismissedRef.current) return
    const missing = symTypes.filter(st => st.template_count === 0)
    if (missing.length > 0) {
      setWizardStep(0)
      setWizardShow(true)
    }
  }, [image]) // eslint-disable-line

  // Fit on image load
  useEffect(() => {
    if (!image || !canvasRef.current) return
    const c = canvasRef.current
    const sx = c.width  / image.width
    const sy = c.height / image.height
    zoomRef.current = Math.min(sx, sy) * 0.95
    panRef.current  = {
      x: (c.width  - image.width  * zoomRef.current) / 2,
      y: (c.height - image.height * zoomRef.current) / 2,
    }
    redraw()
  }, [image]) // eslint-disable-line

  const getTypeConfig = useCallback(code => {
    const st = symTypes.find(t => t.code === code)
    return { color: st ? st.color : '#8892a8', r: 14 }
  }, [symTypes])

  const snipTypeColor = useCallback(() => {
    if (!snipMode) return 'var(--ok)'
    const st = symTypes.find(t => t.id === snipMode)
    return st ? st.color : 'var(--ok)'
  }, [snipMode, symTypes])

  // ── Redraw ────────────────────────────────────────────────────────────────
  const redrawRef = useRef(null)
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx  = canvas.getContext('2d')
    const zoom = zoomRef.current
    const pan  = panRef.current
    const img  = image
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (img) ctx.drawImage(img, pan.x, pan.y, img.width * zoom, img.height * zoom)

    const pn   = pages[pageIdx]?.page_number
    const dets = detections[pn] || []

    dets.forEach(d => {
      if (!img) return
      const x   = d.imgX * img.width  * zoom + pan.x
      const y   = d.imgY * img.height * zoom + pan.y
      const cfg = getTypeConfig(d.type)
      const r   = cfg.r
      const sel = d.id === selectedId

      if (sel) { ctx.save(); ctx.shadowColor = cfg.color; ctx.shadowBlur = 14 }

      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = cfg.color + '30'; ctx.fill()
      ctx.lineWidth = sel ? 3 : 2; ctx.strokeStyle = cfg.color; ctx.stroke()
      ctx.lineWidth = 1.5; ctx.beginPath()
      ctx.moveTo(x - r * .5, y); ctx.lineTo(x + r * .5, y)
      ctx.moveTo(x, y - r * .5); ctx.lineTo(x, y + r * .5)
      ctx.strokeStyle = cfg.color; ctx.stroke()

      // Label
      const label = d.type === 'CCTV_Dome' ? 'DOME' : d.type === 'CCTV_Fixed' ? 'FIX' : d.type
      ctx.font = `bold ${Math.max(8, r * .7)}px Arial`
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillStyle = cfg.color
      ctx.fillText(label, x, y - r - 2)

      // Door-ref badge
      if (d.door_ref) {
        ctx.font = '9px Arial'; ctx.textBaseline = 'top'
        ctx.fillStyle = '#94a3b8'
        ctx.fillText(d.door_ref, x, y + r + 2)
      }

      // text_fallback warning dot
      if (d.method === 'text_fallback') {
        ctx.beginPath(); ctx.arc(x + r - 3, y - r + 3, 4, 0, Math.PI * 2)
        ctx.fillStyle = '#f97316'; ctx.fill()
      }

      if (sel) ctx.restore()
    })

    // Snip rectangle
    if (snipRect) {
      const col = snipTypeColor()
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([6, 3])
      ctx.strokeRect(snipRect.x1, snipRect.y1, snipRect.x2 - snipRect.x1, snipRect.y2 - snipRect.y1)
      ctx.fillStyle = col + '18'
      ctx.fillRect(snipRect.x1, snipRect.y1, snipRect.x2 - snipRect.x1, snipRect.y2 - snipRect.y1)
      ctx.setLineDash([])
    }
  }, [image, detections, pages, pageIdx, selectedId, snipRect, snipTypeColor, getTypeConfig])

  redrawRef.current = redraw
  useEffect(() => { redraw() }, [redraw])

  // ── Canvas interaction helpers ────────────────────────────────────────────
  const canvasCoords = e => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top }
  }

  const hitTest = (cx, cy, pn) => {
    const dets = detections[pn] || []
    if (!image) return null
    const zoom = zoomRef.current; const pan = panRef.current
    return dets.find(d => {
      const dx = d.imgX * image.width  * zoom + pan.x
      const dy = d.imgY * image.height * zoom + pan.y
      return Math.hypot(cx - dx, cy - dy) <= 18
    }) || null
  }

  const canvasToImg = (cx, cy) => ({
    x: (cx - panRef.current.x) / (image.width  * zoomRef.current),
    y: (cy - panRef.current.y) / (image.height * zoomRef.current),
  })

  // ── Single click: select marker ───────────────────────────────────────────
  const canvasClick = useCallback(e => {
    if (snipMode) return
    if (dragMovedRef.current) { dragMovedRef.current = false; return }
    if (dblClickRef.current) { dblClickRef.current = false; return }  // swallow post-dblclick click
    if (!canvasRef.current || !image) return
    const { cx, cy } = canvasCoords(e)
    const pn = pages[pageIdx]?.page_number
    const hit = hitTest(cx, cy, pn)
    if (hit) setSelectedId(id => id === hit.id ? null : hit.id)
  }, [image, pages, pageIdx, snipMode])

  // ── Double-click: place a new detection marker ────────────────────────────
  const canvasDblClick = useCallback(e => {
    if (snipMode || !image) return
    dblClickRef.current = true
    const { cx, cy } = canvasCoords(e)
    const pn = pages[pageIdx]?.page_number
    const { x: imgX, y: imgY } = canvasToImg(cx, cy)
    if (imgX < 0 || imgY < 0 || imgX > 1 || imgY > 1) return
    const det = { id: nextIdRef.current++, type: activeType, imgX, imgY, verified: true, method: 'manual' }
    setDetections(prev => ({ ...prev, [pn]: [...(prev[pn] || []), det] }))
    setSelectedId(det.id)
  }, [image, pages, pageIdx, activeType, snipMode])

  // ── Scroll: zoom ──────────────────────────────────────────────────────────
  const handleWheel = useCallback(e => {
    e.preventDefault()
    const canvas = canvasRef.current
    const rect   = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left; const cy = e.clientY - rect.top
    const f  = e.deltaY < 0 ? 1.12 : 0.89
    const nz = Math.max(0.05, Math.min(10, zoomRef.current * f))
    panRef.current = {
      x: cx - (cx - panRef.current.x) * (nz / zoomRef.current),
      y: cy - (cy - panRef.current.y) * (nz / zoomRef.current),
    }
    zoomRef.current = nz
    redrawRef.current()
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    wrap.addEventListener('wheel', handleWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const down = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null) {
        const pn = pages[pageIdx]?.page_number
        setDetections(prev => ({ ...prev, [pn]: (prev[pn] || []).filter(d => d.id !== selectedId) }))
        setSelectedId(null)
      }
      const idx = parseInt(e.key) - 1
      if (!isNaN(idx) && idx >= 0 && idx < symTypes.length) setActiveType(symTypes[idx].code)
      if (e.key === 'Escape') {
        setSelectedId(null); setCtxMenu(null); setDoorRefEdit(null)
        setSnipMode(null); setSnipRect(null)
      }
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); savePage() }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [selectedId, pages, pageIdx, symTypes, snipMode])

  // ── Mouse events ──────────────────────────────────────────────────────────
  const mouseDown = e => {
    setCtxMenu(null)
    if (e.button !== 0 && e.button !== 1) return

    // Snip mode: start drawing selection box
    if (snipMode && e.button === 0) {
      const { cx, cy } = canvasCoords(e)
      snipStartRef.current = { cx, cy }
      const r = { x1: cx, y1: cy, x2: cx, y2: cy }
      snipRectRef.current = r
      setSnipRect(r)
      return
    }

    if (!image) return
    const { cx, cy } = canvasCoords(e)
    const pn  = pages[pageIdx]?.page_number
    const hit = hitTest(cx, cy, pn)

    if (hit && e.button === 0) {
      // Start drag-to-move on a marker
      draggingRef.current  = { id: hit.id, pn, origImgX: hit.imgX, origImgY: hit.imgY, startCx: cx, startCy: cy }
      dragMovedRef.current = false
    } else {
      // Pan: anywhere that isn't a marker (or middle-button)
      panningRef.current = true
      panStartRef.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y }
      if (wrapRef.current) wrapRef.current.style.cursor = 'grabbing'
    }
  }

  const mouseMove = e => {
    if (panningRef.current) {
      panRef.current = {
        x: panStartRef.current.px + (e.clientX - panStartRef.current.x),
        y: panStartRef.current.py + (e.clientY - panStartRef.current.y),
      }
      redrawRef.current()
      return
    }
    if (snipMode && snipStartRef.current) {
      const { cx, cy } = canvasCoords(e)
      const s = snipStartRef.current
      const r = { x1: Math.min(s.cx, cx), y1: Math.min(s.cy, cy),
                  x2: Math.max(s.cx, cx), y2: Math.max(s.cy, cy) }
      snipRectRef.current = r   // always-current — mouseUp reads this, not snipRect state
      setSnipRect(r)            // state drives canvas redraw only
      return
    }
    // Drag-to-move
    if (draggingRef.current && image) {
      const { cx, cy } = canvasCoords(e)
      const drag = draggingRef.current
      const dist = Math.hypot(cx - drag.startCx, cy - drag.startCy)
      if (dist > 4) {
        dragMovedRef.current = true
        if (wrapRef.current) wrapRef.current.style.cursor = 'grabbing'
        const { x: imgX, y: imgY } = canvasToImg(cx, cy)
        const clamped = { imgX: Math.max(0, Math.min(1, imgX)), imgY: Math.max(0, Math.min(1, imgY)) }
        setDetections(prev => ({
          ...prev,
          [drag.pn]: (prev[drag.pn] || []).map(d =>
            d.id === drag.id ? { ...d, ...clamped } : d
          ),
        }))
      }
    }
  }

  const mouseUp = async e => {
    if (panningRef.current) {
      panningRef.current = false
      if (wrapRef.current) wrapRef.current.style.cursor = snipMode ? 'crosshair' : 'default'
      return
    }

    // Finalise drag-to-move
    if (draggingRef.current) {
      const drag = draggingRef.current
      draggingRef.current = null
      if (wrapRef.current) wrapRef.current.style.cursor = 'crosshair'

      if (dragMovedRef.current) {
        // Find updated position
        const pn   = drag.pn
        const dets = detections[pn] || []
        const moved = dets.find(d => d.id === drag.id)
        if (moved) {
          // Record position correction for the learning loop
          apiFetch(`/drawings/${drawingId}/feedback`, {
            method: 'POST',
            body: JSON.stringify({
              page_number:   pn,
              feedback_type: 'position_correction',
              symbol_code:   moved.type,
              old_img_x:     drag.origImgX,
              old_img_y:     drag.origImgY,
              new_img_x:     moved.imgX,
              new_img_y:     moved.imgY,
            }),
          }).catch(() => {})  // fire-and-forget, don't block the UI
          setSelectedId(drag.id)
        }
        dragMovedRef.current = false
        return  // don't fall through to click handling
      }
      // Tiny movement = treat as a click (select/deselect)
      dragMovedRef.current = false
      setSelectedId(id => id === drag.id ? null : drag.id)
      return
    }

    if (snipMode && snipRectRef.current && snipStartRef.current) {
      snipStartRef.current = null
      const sr = snipRectRef.current   // use ref — always the final drag position, never stale
      snipRectRef.current = null
      const { x: x1, y: y1 } = canvasToImg(sr.x1, sr.y1)
      const { x: x2, y: y2 } = canvasToImg(sr.x2, sr.y2)
      // Minimum size in IMAGE PIXELS, not page fraction — small symbols (e.g. AC
      // doors) on a large A1 page were failing the old 0.5%-of-page check and the
      // snip was silently discarded.
      const pxW = Math.abs(x2 - x1) * (image?.width  || 0)
      const pxH = Math.abs(y2 - y1) * (image?.height || 0)
      const MIN_SNIP_PX = 8
      if (pxW >= MIN_SNIP_PX && pxH >= MIN_SNIP_PX) {
        setSnipSaving(true)
        try {
          const result = await apiFetch(`/drawings/${drawingId}/crop-template`, {
            method: 'POST',
            body: JSON.stringify({
              symbol_type_id: snipMode,
              page_number:    pages[pageIdx]?.page_number || 1,
              x1: Math.min(x1, x2), y1: Math.min(y1, y2),
              x2: Math.max(x1, x2), y2: Math.max(y1, y2),
            }),
          })
          if (result) {
            showToast(`Template saved for ${result.symbol_code}`, 'success')
            // Update template_count in local symTypes state
            setSymTypes(prev => prev.map(st =>
              st.code === result.symbol_code
                ? { ...st, template_count: (st.template_count || 0) + 1 }
                : st
            ))
            // If wizard is active for this symbol type, capture the preview
            if (wizardShow) {
              setWizardPreview({ url: result.image_url })
            }
          }
        } catch (err) { showToast('Template save failed: ' + err.message, 'error') }
        setSnipSaving(false)
      } else if (pxW > 1 || pxH > 1) {
        // User drew a box but it's too small — tell them instead of failing silently
        showToast('Snip too small — zoom in and drag a slightly larger box around the symbol', 'error')
      }
      setSnipRect(null)
      if (!wizardShow) setSnipMode(null)  // wizard manages snipMode itself
    }
  }

  // Update cursor on hover
  const handleMouseHover = e => {
    if (draggingRef.current || panningRef.current) return
    if (!image) return
    if (snipMode) { if (wrapRef.current) wrapRef.current.style.cursor = 'crosshair'; return }
    const { cx, cy } = canvasCoords(e)
    const pn  = pages[pageIdx]?.page_number
    const hit = hitTest(cx, cy, pn)
    if (wrapRef.current) wrapRef.current.style.cursor = hit ? 'grab' : 'default'
  }

  const handleRightClick = e => {
    e.preventDefault()
    const { cx, cy } = canvasCoords(e)
    const pn  = pages[pageIdx]?.page_number
    const hit = hitTest(cx, cy, pn)
    if (hit) setCtxMenu({ x: e.clientX, y: e.clientY, det: hit, pn })
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const savePage = useCallback(async () => {
    setSaving(true)
    const pn = curPage?.page_number
    try {
      await apiFetch(`/drawings/${drawingId}/detections`, {
        method: 'PUT',
        body: JSON.stringify({ page_number: pn, detections: detections[pn] || [] }),
      })
      showToast(`Page ${pn} saved`, 'success')
      // Navigate back to project overview after saving
      setTimeout(() => onNavigate('project', { id: projectId }), 600)
    } catch (err) { showToast(err.message, 'error') }
    finally { setSaving(false) }
  }, [curPage, drawingId, detections])

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const acceptAllOfType = type => {
    const pn = curPage?.page_number
    showToast(`All ${type} on page ${pn} accepted`, 'success')
    // Already in detections — just a visual confirmation
  }

  const removeAllOfType = type => {
    const pn = curPage?.page_number
    if (!confirm(`Remove ALL ${type} detections from page ${pn}?`)) return
    setDetections(prev => ({
      ...prev, [pn]: (prev[pn] || []).filter(d => d.type !== type),
    }))
    showToast(`Removed all ${type} from page ${pn}`, 'info')
    setSelectedId(null)
  }

  // ── Door-ref correction ───────────────────────────────────────────────────
  const openDoorRefEditor = (det, pn) => {
    setCtxMenu(null)
    setDoorRefEdit({ det, pn })
    setDoorRefValue(det.door_ref || '')
  }

  const saveDoorRef = async () => {
    if (!doorRefEdit) return
    const { det, pn } = doorRefEdit
    try {
      await apiFetch(`/drawings/${drawingId}/door-refs`, {
        method: 'PATCH',
        body: JSON.stringify({
          page_number: pn,
          det_imgX: det.imgX,
          det_imgY: det.imgY,
          door_ref: doorRefValue,
        }),
      })
      // Update local state
      setDetections(prev => ({
        ...prev,
        [pn]: (prev[pn] || []).map(d =>
          d.id === det.id ? { ...d, door_ref: doorRefValue || undefined } : d
        ),
      }))
      showToast('Door reference updated', 'success')
    } catch (err) { showToast(err.message, 'error') }
    setDoorRefEdit(null)
  }

  // ── Counts ────────────────────────────────────────────────────────────────
  const countByType   = type => (detections[curPage?.page_number] || []).filter(d => d.type === type).length
  const totalByType   = type => Object.values(detections).flat().filter(d => d.type === type).length

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div id="verify-view">
      <div id="verify-topbar">
        <button className="btn btn-ghost btn-sm"
                onClick={() => onNavigate('project', { id: projectId })}>← Back</button>
        <span className="drawing-title">{drawing?.original_name || '…'}</span>
        {drawing?.revision && (
          <span style={{ fontSize: 11, background: 'var(--bg3)', padding: '2px 8px',
                         borderRadius: 4, color: 'var(--text3)' }}>
            Rev {drawing.revision}
          </span>
        )}
        {pages.length > 1 && (
          <div className="vpage-nav">
            <button className="btn btn-ghost btn-sm" disabled={pageIdx === 0}
                    onClick={() => { setPageIdx(i => i - 1); setSelectedId(null) }}>‹</button>
            <span>Page {pageIdx + 1} of {pages.length}</span>
            <button className="btn btn-ghost btn-sm" disabled={pageIdx >= pages.length - 1}
                    onClick={() => { setPageIdx(i => i + 1); setSelectedId(null) }}>›</button>
          </div>
        )}
        {/* Page completion indicator */}
        {pages.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            {pages.filter(p => p.verified).length}/{pages.length} pages saved
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-success btn-sm" onClick={savePage} disabled={saving}>
          {saving ? <span className="spinner" /> : 'Save Page'}
        </button>
      </div>

      <div id="verify-body">
        <div id="verify-sidebar">
          {/* Symbol type selector */}
          <div className="vsec">
            <div className="vsec-title">Symbols</div>
            {snipMode && (
              <div className="snip-note">
                {snipSaving ? 'Saving…' : 'Drag a box around one clear example on the drawing'}
                <button className="snip-note-close"
                        onClick={() => { setSnipMode(null); setSnipRect(null) }}>×</button>
              </div>
            )}
            {symTypes.map(st => (
              <div key={st.id} className="sym-row">
                <button className={`sym-btn${activeType === st.code ? ' active' : ''}`}
                        onClick={() => { setActiveType(st.code); setSnipMode(null) }}>
                  <span className="dot"
                        title={st.template_count === 0
                          ? 'No examples yet — snip one to improve detection'
                          : undefined}
                        style={{ background: st.template_count === 0 ? 'transparent' : st.color,
                                 border: `2px solid ${st.color}` }} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{st.name}</span>
                  <span className="cnt">{countByType(st.code)}</span>
                </button>
                <button className={`snip-btn${snipMode === st.id ? ' active' : ''}`}
                        title={`Snip an example of ${st.name} from the drawing`}
                        onClick={() => { setSnipMode(snipMode === st.id ? null : st.id); setSnipRect(null) }}>
                  Snip
                </button>
              </div>
            ))}
            <p className="hint" style={{ marginTop: 8 }}>
              Hollow dot = no example yet. Press <kbd>1</kbd>–<kbd>9</kbd> to switch.
            </p>
          </div>

          {/* Bulk actions — only when this page has detections */}
          {symTypes.some(st => countByType(st.code) > 0) && (
            <div className="vsec">
              <div className="vsec-title">This Page</div>
              {symTypes.map(st => {
                const count = countByType(st.code)
                if (count === 0) return null
                return (
                  <div key={st.id} className="bulk-row">
                    <span className="dot" style={{ background: st.color }} />
                    <span className="bulk-name">{st.name}</span>
                    <span className="bulk-count">{count}</span>
                    <button className="snip-btn" onClick={() => acceptAllOfType(st.code)}
                            title="Mark all as correct">Keep</button>
                    <button className="snip-btn danger" onClick={() => removeAllOfType(st.code)}
                            title="Remove all">Clear</button>
                  </div>
                )
              })}
            </div>
          )}

          {/* All-pages totals */}
          <div className="vsec">
            <div className="vsec-title">Totals — All Pages</div>
            {symTypes.map(st => (
              <div key={st.id} className="total-row">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="dot" style={{ background: st.color }} />
                  {st.name}
                </span>
                <strong>{totalByType(st.code)}</strong>
              </div>
            ))}
          </div>

          {/* Controls — essentials visible, the rest folded away */}
          <div className="vsec">
            <p className="hint">
              <strong>Double-click</strong> places a marker · <strong>right-click</strong> corrects one
            </p>
            <details className="v-details">
              <summary>All controls</summary>
              <p className="hint">
                <strong>Click</strong> marker → select<br />
                <strong>Drag</strong> → pan · <strong>drag marker</strong> → move<br />
                <strong>Snip</strong> → teach detection from this drawing<br />
                <kbd>Del</kbd> remove &nbsp; <kbd>Esc</kbd> deselect<br />
                <kbd>Ctrl+S</kbd> save &nbsp; <kbd>Scroll</kbd> zoom
              </p>
            </details>
          </div>
        </div>

        {/* Right-click correction menu */}
        {ctxMenu && (
          <div style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 200,
                        background: 'var(--bg2)', border: '1px solid var(--border)',
                        borderRadius: 8, padding: 4, minWidth: 200,
                        boxShadow: '0 4px 12px #0006' }}
               onClick={() => setCtxMenu(null)}>
            <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--text3)',
                          borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
              Detected as: <strong style={{ color: 'var(--text)' }}>{ctxMenu.det.type}</strong>
              {ctxMenu.det.door_ref && <span> · {ctxMenu.det.door_ref}</span>}
            </div>
            <CtxItem color="var(--red)" onClick={() => {
              setDetections(prev => ({
                ...prev, [ctxMenu.pn]: (prev[ctxMenu.pn] || []).filter(d => d.id !== ctxMenu.det.id),
              }))
              setCtxMenu(null)
              showToast('Marked as false positive — will improve detection', 'info')
            }}>
              Remove — false positive
            </CtxItem>
            <CtxItem color="var(--text2)" onClick={() => openDoorRefEditor(ctxMenu.det, ctxMenu.pn)}>
              Correct door reference
            </CtxItem>
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
            {symTypes.filter(st => st.code !== ctxMenu.det.type).map(st => (
              <CtxItem key={st.id} color={st.color} onClick={() => {
                setDetections(prev => ({
                  ...prev,
                  [ctxMenu.pn]: (prev[ctxMenu.pn] || []).map(d =>
                    d.id === ctxMenu.det.id ? { ...d, type: st.code } : d
                  ),
                }))
                setCtxMenu(null)
                showToast(`Changed to ${st.name}`, 'success')
              }}>
                → Change to {st.name}
              </CtxItem>
            ))}
          </div>
        )}

        {/* ── Symbol Setup Wizard ────────────────────────────────────────── */}
        {wizardShow && (() => {
          const wizardTypes = symTypes.filter(st => st.template_count === 0)
          const current     = wizardTypes[wizardStep]
          const allDone     = wizardStep >= wizardTypes.length

          const closeWizard = () => {
            setWizardShow(false)
            setWizardPreview(null)
            setSnipMode(null)
            wizardDismissedRef.current = true
          }

          const startSnip = () => {
            if (!current) return
            setWizardPreview(null)
            setSnipMode(current.id)
          }

          const confirmSnip = () => {
            setWizardPreview(null)
            setSnipMode(null)
            const next = wizardStep + 1
            setWizardStep(next)
            if (next >= wizardTypes.length) {
              closeWizard()
              showToast('Symbol setup complete — detection will improve from here!', 'success')
            } else {
              // Auto-enable snip for next symbol
              const nextType = wizardTypes[next]
              if (nextType) setSnipMode(nextType.id)
            }
          }

          const skipCurrent = () => {
            setWizardPreview(null)
            setSnipMode(null)
            const next = wizardStep + 1
            setWizardStep(next)
            if (next >= wizardTypes.length) closeWizard()
            else {
              const nextType = wizardTypes[next]
              if (nextType) setSnipMode(nextType.id)
            }
          }

          return (
            <div style={{
              position: 'absolute', top: 16, right: 16, zIndex: 150,
              width: 290, background: 'var(--bg2)', border: '2px solid var(--ink)',
              borderRadius: 'var(--radius)', padding: 18,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600 }}>
                  Symbol Setup
                </span>
                <div style={{ flex: 1 }} />
                <button className="btn btn-ghost btn-sm" onClick={closeWizard}
                        title="Skip setup — can run snips manually later">×</button>
              </div>

              {allDone ? (
                <p style={{ fontSize: 12, color: 'var(--ok)' }}>
                  All symbol types have examples — detection improves from here.
                </p>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
                    Step {wizardStep + 1} of {wizardTypes.length}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%',
                                   background: current?.color || '#8892a8',
                                   display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                      {current?.name}
                    </span>
                  </div>

                  {wizardPreview ? (
                    <>
                      <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
                        Does this look like a good example?
                      </p>
                      <img
                        src={`${wizardPreview.url}?t=${Date.now()}`}
                        alt="snip preview"
                        style={{ width: '100%', border: '1px solid var(--border)',
                                 borderRadius: 6, marginBottom: 10, imageRendering: 'pixelated',
                                 background: '#fff' }}
                        onError={e => { e.target.style.display = 'none' }}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost btn-sm" style={{ flex: 1 }}
                                onClick={startSnip}>↩ Redo</button>
                        <button className="btn btn-success btn-sm" style={{ flex: 1 }}
                                onClick={confirmSnip}>Confirm</button>
                      </div>
                    </>
                  ) : snipMode === current?.id ? (
                    <>
                      <p style={{ fontSize: 12, color: '#fb923c', marginBottom: 8 }}>
                        <strong>Drag a box</strong> around a clear {current?.name} symbol on the drawing below.
                      </p>
                      <button className="btn btn-ghost btn-sm" style={{ width: '100%' }}
                              onClick={skipCurrent}>Skip this symbol →</button>
                    </>
                  ) : (
                    <>
                      <p style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
                        Find a clear <strong>{current?.name}</strong> on the drawing and snip it as a template example.
                      </p>
                      <button className="btn btn-primary btn-sm" style={{ width: '100%', marginBottom: 6 }}
                              onClick={startSnip}>Snip {current?.name}</button>
                      <button className="btn btn-ghost btn-sm" style={{ width: '100%' }}
                              onClick={skipCurrent}>Skip →</button>
                    </>
                  )}

                  {/* Progress dots */}
                  <div style={{ display: 'flex', gap: 4, marginTop: 12, justifyContent: 'center' }}>
                    {wizardTypes.map((_, i) => (
                      <span key={i} style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: i < wizardStep ? 'var(--ok)' : i === wizardStep ? 'var(--link)' : 'var(--border)',
                      }} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        })()}

        {/* Door-ref editor */}
        {doorRefEdit && (
          <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setDoorRefEdit(null)}>
            <div className="modal" style={{ maxWidth: 380 }}>
              <h2>Edit Door Reference</h2>
              <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 16 }}>
                Set the door reference code for this detection.<br />
                Format: D_BA01.00.20
              </p>
              <div className="form-group">
                <label>Door Reference</label>
                <input className="form-control" value={doorRefValue}
                       onChange={e => setDoorRefValue(e.target.value)}
                       placeholder="e.g. D_BA01.00.20 (leave empty to clear)"
                       autoFocus />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => setDoorRefEdit(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveDoorRef}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* Canvas */}
        <div id="canvas-wrap" ref={wrapRef}
             style={{ cursor: snipMode ? 'crosshair' : 'default' }}
             onClick={canvasClick}
             onDoubleClick={canvasDblClick}
             onContextMenu={handleRightClick}
             onMouseDown={mouseDown}
             onMouseMove={e => { mouseMove(e); handleMouseHover(e) }}
             onMouseUp={mouseUp}>
          <canvas id="vcanvas" ref={canvasRef} />
          <div id="v-loading" className={loadingPage ? 'show' : ''}>
            <span className="spinner spinner-lg" />
            <span style={{ color: 'var(--text2)', fontSize: 13 }}>Loading page…</span>
          </div>
          {drawing && ['uploaded', 'processing'].includes(drawing.status) && curPage && (
            <div className="canvas-note">
              <span className="spinner" /> Detection running — markers will appear automatically
            </div>
          )}
          {!loadingPage && !image && (pageError || !curPage) && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                          alignItems: 'center', justifyContent: 'center', gap: 10,
                          textAlign: 'center', padding: 32, pointerEvents: 'none' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--red)' }}>
                {pageError ? 'Page image failed to load'
                  : drawing?.status === 'error' ? 'Detection failed for this drawing'
                  : drawing?.status === 'processing' || drawing?.status === 'uploaded'
                    ? 'This drawing is still being processed'
                    : 'No pages available for this drawing'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text2)', maxWidth: 520 }}>
                {pageError
                  || drawing?.error_message
                  || (drawing?.status === 'processing' || drawing?.status === 'uploaded'
                      ? 'Detection runs in the background after upload — go back and retry in a moment.'
                      : 'Check the backend log (backend/logs/app.log) for details.')}
              </div>
            </div>
          )}
          {curDets.some(d => d.method === 'text_fallback') && (
            <div style={{ position: 'absolute', bottom: 16, left: 16, background: 'var(--bg2)',
                          color: 'var(--ink)', padding: '8px 14px', fontSize: 12, fontWeight: 600,
                          border: '2px solid var(--ink)', borderLeft: '6px solid var(--accent)' }}>
              Orange-flagged markers are text-detected — positions are approximate, drag them into place
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CtxItem({ color, onClick, children }) {
  return (
    <div style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 13, color, borderRadius: 4 }}
         onMouseEnter={e => e.target.style.background = 'var(--bg3)'}
         onMouseLeave={e => e.target.style.background = ''}
         onClick={onClick}>
      {children}
    </div>
  )
}
