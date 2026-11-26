import React from 'react'

/* A door job in three steps: the doors (read, checked, given their sets), their
   prices, and the schedule made from them. Shown on each step's page. */
const STEPS = [
  { key: 'doors', label: 'Doors and sets', view: 'plan-reader' },
  { key: 'prices', label: 'Prices', view: 'cost' },
  { key: 'schedule', label: 'Schedule', view: 'schedule' },
]

export function JobSteps({ projectId, at, onNavigate, compact = false }) {
  return (
    <nav className={`job-steps${compact ? ' compact' : ''}`} aria-label="Job steps">
      {STEPS.map((s, i) => (
        <button key={s.key} className={s.key === at ? 'on' : ''} aria-current={s.key === at ? 'step' : undefined}
                onClick={() => s.key !== at && onNavigate(s.view, { id: projectId })}>
          <span className="job-step-n">{i + 1}</span>{s.label}
        </button>
      ))}
    </nav>
  )
}
