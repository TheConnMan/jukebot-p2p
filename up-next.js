// Whether the Up next list shows only the first queued item. A panel shorter
// than SHORT_PX collapses on its own; a manual choice (true collapsed, false
// expanded, null none) wins until the panel crosses the threshold again.
export const SHORT_PX = 800

export const collapsed = ({short, manual}) => manual ?? short

// The next state after the panel's height changes. Crossing the threshold
// drops a manual choice so the automatic behavior applies again.
export function resized(state, height) {
  const short = height < SHORT_PX
  return short === state.short ? state : {short, manual: null}
}

export const toggled = state => ({...state, manual: !collapsed(state)})

// Label for the toggle and the "+N more" note beside the first item.
export function labels(state, queueLength) {
  const hidden = Math.max(0, queueLength - 1)
  return {
    toggle: collapsed(state) ? (hidden ? `Show all (${queueLength})` : 'Expand') : 'Collapse',
    more: collapsed(state) && hidden ? `+${hidden} more` : ''
  }
}
