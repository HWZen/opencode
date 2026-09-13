import { createEffect, createMemo, createResource, onCleanup, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

const DEFAULT_OPACITY = 12
const DEFAULT_BLUR = 0

type BackgroundSource = {
  id?: string
  worktree: string
  background?: {
    url?: string
    override?: string
    opacity?: number
    blur?: number
  }
}

export function ProjectBackground(props: { project?: BackgroundSource; directory?: string }) {
  const sdk = useServerSDK()
  const serverSync = useServerSync()
  const project = createMemo<BackgroundSource | undefined>(() => {
    if (props.project) return props.project
    const directory = props.directory
    if (!directory) return
    const [child] = serverSync().child(directory, { bootstrap: false })
    const metadata =
      (child.project ? serverSync().data.project.find((item) => item.id === child.project) : undefined) ??
      serverSync().data.project.find((item) => pathKey(item.worktree) === pathKey(directory))
    const base: BackgroundSource = metadata ?? { id: child.project || undefined, worktree: directory }
    const stored = child.background ?? child.projectMeta?.background
    if (!stored) return base
    return { ...base, background: { ...base.background, ...stored } }
  })
  const override = createMemo(() => project()?.background?.override || undefined)
  const remote = createMemo(() => {
    const target = project()
    if (!target?.id || !target.background?.url) return
    if (target.background.override) return
    return { projectID: target.id, directory: target.worktree }
  })
  const [remoteSource] = createResource(remote, async (input) => {
    const result = await sdk().client.project.background({
      projectID: input.projectID,
      directory: input.directory,
    })
    if (!(result.data instanceof Blob)) return undefined
    return URL.createObjectURL(result.data)
  })
  let previous: string | undefined
  createEffect(() => {
    const next = remoteSource()
    if (previous && previous !== next) URL.revokeObjectURL(previous)
    previous = typeof next === "string" ? next : undefined
  })
  onCleanup(() => {
    if (previous) URL.revokeObjectURL(previous)
  })

  const source = createMemo(() => override() ?? remoteSource())
  const opacity = createMemo(() => project()?.background?.opacity ?? DEFAULT_OPACITY)
  const blur = createMemo(() => project()?.background?.blur ?? DEFAULT_BLUR)

  return (
    <Show when={source()}>
      {(src) => (
        <div
          aria-hidden="true"
          class="fixed inset-0 z-40 pointer-events-none"
          style={{
            "background-image": `url(${src()})`,
            "background-size": "cover",
            "background-position": "center",
            "mix-blend-mode": "soft-light",
            opacity: String(opacity() / 100),
            filter: `blur(${blur()}px)`,
          }}
        />
      )}
    </Show>
  )
}
