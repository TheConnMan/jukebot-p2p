export const DIRECTORY_URL = 'https://jukebot-directory.theconnman.workers.dev'

export async function directory(path, options = {}) {
  const {directoryUrl = DIRECTORY_URL} = await chrome.runtime.sendMessage({to: 'bg', type: 'directoryConfig'})
  const response = await fetch(`${directoryUrl}${path}`, {
    ...options,
    headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(`Directory unavailable (${response.status}). Try again later.`)
  return response.json()
}
