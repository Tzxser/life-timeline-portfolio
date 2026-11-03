'use client'

import { useEffect, useRef, useState } from 'react'
import { SEASON_LABELS, seasonForDate, type LifeSeason } from '@/lib/seasonal'

const MIN_VISIBLE_MS = 680
const MAX_VISIBLE_MS = 1500
const FADE_MS = 190

interface SeasonalSplashProps {
  enabled: boolean
  ready: boolean
}

export function SeasonalSplash({ enabled, ready }: SeasonalSplashProps) {
  const [phase, setPhase] = useState<'visible' | 'fading' | 'hidden'>(enabled ? 'visible' : 'hidden')
  const startedAt = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setPhase('hidden')
      return
    }
    startedAt.current = performance.now()
    setPhase('visible')
    const fadeTimer = window.setTimeout(() => setPhase('fading'), MAX_VISIBLE_MS)
    const hideTimer = window.setTimeout(() => setPhase('hidden'), MAX_VISIBLE_MS + FADE_MS)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(hideTimer)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !ready || !startedAt.current) return
    const elapsed = performance.now() - startedAt.current
    const delay = Math.max(0, MIN_VISIBLE_MS - elapsed)
    const fadeTimer = window.setTimeout(() => {
      setPhase('fading')
      window.setTimeout(() => setPhase('hidden'), FADE_MS)
    }, delay)
    return () => window.clearTimeout(fadeTimer)
  }, [enabled, ready])

  if (!enabled || phase === 'hidden') return null
  const season = seasonForDate(new Date())
  return (
    <div
      className="lt-seasonal-splash"
      data-season={season}
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label={`正在打开 life-timeline · ${SEASON_LABELS[season]}季`}
    >
      <div className="lt-seasonal-splash-inner">
        <SeasonalArtwork season={season} />
        <div className="lt-seasonal-splash-name">life-timeline</div>
        <div className="lt-seasonal-splash-season">{SEASON_LABELS[season]} · 记录此刻，也回望一生</div>
      </div>
    </div>
  )
}

function SeasonalArtwork({ season }: { season: LifeSeason }) {
  const common = {
    viewBox: '0 0 240 180',
    role: 'img' as const,
    'aria-label': `${SEASON_LABELS[season]}季线稿`,
    className: 'lt-seasonal-splash-art',
  }
  if (season === 'spring') {
    return (
      <svg {...common}>
        <path d="M20 143 C64 128 93 97 124 52 C139 30 163 25 207 38" />
        <path d="M75 111 C66 91 53 77 36 69 M91 91 C91 69 99 53 113 39" />
        <path className="lt-seasonal-splash-accent" d="M128 50 C137 41 147 39 154 44 C147 51 139 53 128 50 Z M161 35 C171 29 181 31 185 38 C175 42 167 41 161 35 Z M104 63 C112 54 122 54 127 60 C119 66 111 67 104 63 Z" />
        <path d="M183 93 q14 -13 28 0 q-14 4 -28 0 M188 93 l-7 -6 M198 93 l8 -6" />
        <path className="lt-seasonal-splash-accent-fill" d="M39 69 q5 -12 12 0 q-6 7 -12 0 M106 39 q5 -12 12 0 q-6 7 -12 0" />
        <path d="M31 143 C83 150 146 150 210 143" />
      </svg>
    )
  }
  if (season === 'summer') {
    return (
      <svg {...common}>
        <path d="M22 142 C73 132 157 132 218 142" />
        <path d="M46 140 C59 114 83 102 108 113 C93 133 70 141 46 140 Z" />
        <path d="M116 139 C118 104 122 75 126 47" />
        <path d="M126 84 C112 70 109 56 118 43 C134 55 137 69 126 84 Z" />
        <path d="M126 84 C140 69 151 62 164 66 C158 80 146 87 126 84 Z" />
        <path className="lt-seasonal-splash-accent" d="M126 47 C117 35 120 25 129 18 C139 29 137 39 126 47 Z M126 47 C137 36 148 37 154 44 C144 52 135 53 126 47 Z" />
        <path d="M174 44 l20 12 M194 44 l-20 12 M184 38 v25" />
        <circle className="lt-seasonal-splash-accent-fill" cx="184" cy="50" r="4" />
        <path d="M32 151 q20 -9 40 0 q20 -9 40 0 q20 -9 40 0 q20 -9 40 0 q20 -9 40 0" />
      </svg>
    )
  }
  if (season === 'autumn') {
    return (
      <svg {...common}>
        <path d="M119 145 C117 112 119 77 126 37" />
        <path d="M124 61 C99 45 72 44 48 59 C68 72 96 76 124 61 Z M129 53 C151 34 178 31 200 45 C181 61 156 65 129 53 Z" />
        <path className="lt-seasonal-splash-accent-fill" d="M63 77 q-14 5 -18 19 q15 3 22 -8 Z M190 76 q13 5 17 18 q-14 4 -21 -8 Z M145 87 q-13 9 -13 23 q15 -1 19 -12 Z" />
        <path d="M42 145 C84 134 159 134 207 145" />
        <path d="M52 129 q16 -9 33 0 M155 126 q16 -9 34 0" />
        <path d="M181 38 A19 19 0 1 1 173 72 A16 16 0 1 0 181 38 Z" />
        <path d="M31 94 q17 -14 34 0 q-17 6 -34 0 M36 94 l-8 -8 M52 94 l8 -8" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M25 144 C75 135 157 135 216 144" />
      <path d="M67 143 C71 111 76 78 91 45" />
      <path d="M90 64 C73 55 58 57 46 68 C61 78 76 77 90 64 Z M92 58 C103 42 118 37 132 43 C124 58 109 65 92 58 Z" />
      <path className="lt-seasonal-splash-accent" d="M91 45 C89 30 97 20 110 18 C113 32 106 42 91 45 Z M99 42 C112 30 126 31 134 41 C122 49 110 49 99 42 Z" />
      <path d="M166 41 A22 22 0 1 1 157 80 A18 18 0 1 0 166 41 Z" />
      <path className="lt-seasonal-splash-accent-fill" d="M39 35 l4 8 9 1 -7 6 2 9 -8 -5 -8 5 2 -9 -7 -6 9 -1 Z" />
      <path d="M184 108 q12 10 24 0 M189 108 l-5 -8 M199 108 l6 -8 M67 97 l-8 -8 M74 91 l8 -9" />
      <circle cx="35" cy="35" r="2" className="lt-seasonal-splash-accent-fill" />
      <circle cx="154" cy="24" r="2" className="lt-seasonal-splash-accent-fill" />
      <circle cx="207" cy="88" r="2" className="lt-seasonal-splash-accent-fill" />
    </svg>
  )
}
