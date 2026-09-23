export interface MediaPlayerRef {
  entry?: string | null
  bus_name?: string | null
  identity?: string | null
  title?: string | null
}

export interface MediaClientRef {
  address?: string | null
  pid?: number | null
  class?: string | null
  initialClass?: string | null
  initial_class?: string | null
  title?: string | null
}

const normalize = (value: unknown): string => String(value ?? "")
  .toLowerCase()
  .replace(/\.desktop$/i, "")
  .replace(/[^a-z0-9]/g, "")

const aliases = (value: unknown): string[] => {
  const raw = String(value ?? "")
    .trim()
    .replace(/\.desktop$/i, "")
  if (!raw) return []

  const short = raw.slice(raw.lastIndexOf(".") + 1)
  return [...new Set([normalize(raw), normalize(short)].filter(Boolean))]
}

const playerAliases = (player: MediaPlayerRef): Set<string> => {
  const busId = String(player.bus_name ?? "")
    .replace(/^org\.mpris\.MediaPlayer2\./i, "")
    .replace(/\.instance[^.]*$/i, "")

  return new Set([
    ...aliases(player.entry),
    ...aliases(busId),
    ...aliases(player.identity),
  ])
}

const playerInstancePid = (player: MediaPlayerRef): number | null => {
  const match = /\.instance(\d+)(?:\.|$)/i.exec(String(player.bus_name ?? ""))
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** Encuentra la ventana de Hyprland que pertenece al reproductor MPRIS actual. */
export function findMediaClient<T extends MediaClientRef>(
  player: MediaPlayerRef | null | undefined,
  clients: Iterable<T> | null | undefined,
): T | null {
  if (!player) return null

  const wanted = playerAliases(player)
  const instancePid = playerInstancePid(player)
  if (wanted.size === 0 && instancePid === null) return null

  const mediaTitle = normalize(player.title)
  let best: T | null = null
  let bestScore = -1

  for (const client of clients ?? []) {
    if (!client.address) continue

    const clientAliases = new Set([
      ...aliases(client.class),
      ...aliases(client.initialClass ?? client.initial_class),
    ])
    const aliasMatches = [...clientAliases].some((alias) => wanted.has(alias))
    const pidMatches = instancePid !== null && client.pid === instancePid
    if (!aliasMatches && !pidMatches) continue

    // Normalmente solo hay una ventana por reproductor. Si un navegador tiene
    // varias, el título de la pestaña multimedia sirve como desempate cuando
    // Hyprland lo incluye en el título de su ventana.
    const windowTitle = normalize(client.title)
    const titleMatches = mediaTitle.length >= 3 && windowTitle.includes(mediaTitle)
    const score = (pidMatches ? 2 : 0) + (aliasMatches ? 1 : 0) + (titleMatches ? 1 : 0)
    if (score > bestScore) {
      best = client
      bestScore = score
    }
  }

  return best
}
