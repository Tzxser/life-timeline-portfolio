'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The night-sky decoration stays deliberately small and deterministic.  It is
 * a viewport decoration rather than timeline data: it never adds to the
 * scrollable width and cannot affect the diary or event hit targets.
 */
const STARS = [
  { left: '8.5%', top: '21%', size: 1.2, opacity: 0.42 },
  { left: '16%', top: '13%', size: 0.9, opacity: 0.3 },
  { left: '24.5%', top: '31%', size: 1.5, opacity: 0.45 },
  { left: '35%', top: '17%', size: 0.8, opacity: 0.32 },
  { left: '44%', top: '26%', size: 1.1, opacity: 0.38 },
  { left: '53%', top: '11%', size: 0.8, opacity: 0.27 },
  { left: '62%', top: '28%', size: 1.3, opacity: 0.4 },
  { left: '70.5%', top: '16%', size: 0.9, opacity: 0.34 },
  { left: '79%', top: '34%', size: 1.4, opacity: 0.4 },
  { left: '87%', top: '19%', size: 0.8, opacity: 0.3 },
  { left: '93%', top: '29%', size: 1.1, opacity: 0.36 },
] as const

const METEOR_LIFETIME_MS = 900

interface TimelineNightSkyProps {
  night: boolean
}

function initialNightState(night: boolean): boolean {
  if (typeof document === 'undefined') return night
  // The pre-paint theme script normally has already set this class.  Reading
  // it here prevents an initial dark launch from looking like a user toggle.
  return document.documentElement.classList.contains('dark') || night
}

export function TimelineNightSky({ night }: TimelineNightSkyProps) {
  const previousNightRef = useRef<boolean | null>(null)
  const meteorTimerRef = useRef<number | null>(null)
  const [meteorRun, setMeteorRun] = useState(0)

  useEffect(() => {
    if (previousNightRef.current === null) {
      previousNightRef.current = initialNightState(night)
      return
    }
    const wasNight = previousNightRef.current
    if (night && !wasNight) {
      if (meteorTimerRef.current !== null) window.clearTimeout(meteorTimerRef.current)
      setMeteorRun((run) => run + 1)
      meteorTimerRef.current = window.setTimeout(() => {
        meteorTimerRef.current = null
        setMeteorRun(0)
      }, METEOR_LIFETIME_MS)
    } else if (!night) {
      if (meteorTimerRef.current !== null) {
        window.clearTimeout(meteorTimerRef.current)
        meteorTimerRef.current = null
      }
      setMeteorRun(0)
    }
    previousNightRef.current = night
  }, [night])

  useEffect(() => () => {
    if (meteorTimerRef.current !== null) window.clearTimeout(meteorTimerRef.current)
  }, [])

  return (
    <div
      aria-hidden="true"
      className="lt-night-sky"
      data-night-sky={night ? 'true' : 'false'}
      data-meteor-run={meteorRun}
    >
      <div className="lt-night-stars">
        {STARS.map((star, index) => (
          <span
            key={index}
            className="lt-night-star"
            style={{
              left: star.left,
              top: star.top,
              width: `${star.size}px`,
              height: `${star.size}px`,
              opacity: star.opacity,
            }}
          />
        ))}
      </div>
      {meteorRun > 0 && <span key={meteorRun} className="lt-night-meteor" />}
    </div>
  )
}
