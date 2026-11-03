/** Fixed layout shared with the continuous scroll/collapse shell. */
export const TIMELINE_TRACK_HEIGHT = 288
export const TIMELINE_AXIS_Y = 152
export const FIXED_TIMELINE_CLIP_BOTTOM = 118

// Keep one stage band plus breathing room below the expanded year labels.
const EXPANDED_FOOTER_SPACE = 24
// The collapse clip is relative to a block that also contains bottom padding
// (16px) and the controls (at least 42px including their top gap).
const COMPACT_FOOTER_SPACE = FIXED_TIMELINE_CLIP_BOTTOM - 16 - 42 + 8

export interface RulerLayoutInput {
  yearTickHeight: number
  monthTickHeight: number
  weekTickHeight: number
  yearLabelSize: number
  widthScale: number
}

export interface RulerEndpoint {
  yearHeight: number
  monthHeight: number
  weekHeight: number
  /** Label positions are relative to the main axis. */
  yearLabel: number
  monthLabel: number
  weekLabel: number
}

/**
 * Fit a whole ordered ruler into its available lower band. Reserve the complete
 * year line box before sizing ticks; capping only its top would put the label
 * before the end of a long tick and still cut off a larger font.
 *
 * This preserves the usual geometry exactly. Only settings that cannot fit in
 * the fixed track are reduced together, so year/month/week keep their hierarchy.
 */
function fitEndpoint(
  yearHeight: number,
  monthHeight: number,
  weekHeight: number,
  gapScale: number,
  labelDepth: number,
): RulerEndpoint {
  const yearEnd = yearHeight + 4 * gapScale
  const monthEnd = monthHeight + 3 * gapScale
  const weekEnd = weekHeight + 3 * gapScale
  const fit = Math.min(1, labelDepth / yearEnd, (labelDepth - 15) / monthEnd, (labelDepth - 28) / weekEnd)
  const weekLabel = weekEnd * fit
  const monthLabel = Math.max(monthEnd * fit, weekLabel + 13)
  const yearLabel = Math.max(yearEnd * fit, monthLabel + 15)
  return {
    yearHeight: yearHeight * fit,
    monthHeight: monthHeight * fit,
    weekHeight: weekHeight * fit,
    weekLabel,
    monthLabel,
    yearLabel,
  }
}

export function buildRulerLayout(settings: RulerLayoutInput) {
  const yearLineHeight = settings.yearLabelSize * 1.5
  const expandedBottom = TIMELINE_TRACK_HEIGHT - EXPANDED_FOOTER_SPACE
  const compactBottom = TIMELINE_TRACK_HEIGHT - COMPACT_FOOTER_SPACE
  return {
    expandedBottom,
    compactBottom,
    yearLineHeight,
    expanded: fitEndpoint(
      settings.yearTickHeight * settings.widthScale,
      settings.monthTickHeight * settings.widthScale,
      settings.weekTickHeight * settings.widthScale,
      settings.widthScale,
      expandedBottom - TIMELINE_AXIS_Y - yearLineHeight,
    ),
    // A fixed compact endpoint is independent of the user's overview zoom.
    // Larger year text still gets its full line box inside the clipping edge.
    compact: fitEndpoint(44, 26, 16, 1, compactBottom - TIMELINE_AXIS_Y - yearLineHeight),
  }
}
