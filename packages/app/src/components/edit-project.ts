import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import { normalizeProjectInfo } from "@/context/global-sync/utils"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"

export function createEditProjectModel(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const serverCtx = createMemo(() => global.ensureServerCtx(props.server))
  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  const [store, setStore] = createStore({
    name: defaultName(),
    color: props.project.icon?.color,
    iconOverride: props.project.icon?.override,
    backgroundOverride: props.project.background?.override,
    backgroundOpacity: props.project.background?.opacity,
    backgroundBlur: props.project.background?.blur,
    startup: props.project.commands?.start ?? "",
    dragOver: false,
    iconHover: false,
    backgroundDragOver: false,
    backgroundHover: false,
  })
  let iconInput: HTMLInputElement | undefined
  let backgroundInput: HTMLInputElement | undefined

  function selectFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result !== "string") return
      setStore("iconOverride", result)
      setStore("iconHover", false)
    }
    reader.readAsDataURL(file)
  }

  async function selectBackgroundFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const result = await compressImage(file)
    if (!result) return
    setStore("backgroundOverride", result)
    setStore("backgroundHover", false)
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", false)
    const file = event.dataTransfer?.files[0]
    if (file) selectFile(file)
  }

  function dragOver(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", true)
  }

  function dragLeave() {
    setStore("dragOver", false)
  }

  function inputChange(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    if (file) selectFile(file)
  }

  function iconClick() {
    if (store.iconOverride && store.iconHover) {
      setStore("iconOverride", "")
      return
    }
    iconInput?.click()
  }

  function backgroundDrop(event: DragEvent) {
    event.preventDefault()
    setStore("backgroundDragOver", false)
    const file = event.dataTransfer?.files[0]
    if (file) void selectBackgroundFile(file)
  }

  function backgroundDragOver(event: DragEvent) {
    event.preventDefault()
    setStore("backgroundDragOver", true)
  }

  function backgroundDragLeave() {
    setStore("backgroundDragOver", false)
  }

  function backgroundInputChange(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    if (file) void selectBackgroundFile(file)
  }

  function backgroundClick() {
    if (store.backgroundOverride && store.backgroundHover) {
      setStore("backgroundOverride", "")
      return
    }
    backgroundInput?.click()
  }

  const save = useMutation(() => ({
    mutationFn: async () => {
      const name = store.name.trim() === folderName() ? "" : store.name.trim()
      const start = store.startup.trim()
      const background = {
        override: store.backgroundOverride || undefined,
        opacity: store.backgroundOpacity,
        blur: store.backgroundBlur,
      }
      const hasBackground =
        background.override !== undefined || background.opacity !== undefined || background.blur !== undefined

      if (props.project.id && props.project.id !== "global") {
        if ((await serverCtx().sdk.protocol) !== "v1") return
        const project = await serverCtx()
          .sdk.client.project.update({
            projectID: props.project.id,
            directory: props.project.worktree,
            name,
            icon: { color: store.color || "", override: store.iconOverride || "" },
            background: {
              override: store.backgroundOverride || "",
              opacity: store.backgroundOpacity,
              blur: store.backgroundBlur,
            },
            commands: { start },
          })
          .then((result) => result.data)
        if (!project) return
        // const project = await serverCtx().sdk.api.project.update({
        //   projectID: props.project.id,
        //   name,
        //   icon: { color: store.color || "", override: store.iconOverride || "" },
        //   commands: { start },
        // })
        serverCtx().sync.set("project", (items) =>
          items.map((item) => (item.id === project.id ? normalizeProjectInfo(project) : item)),
        )
        serverCtx().sync.project.icon(props.project.worktree, store.iconOverride || undefined)
        serverCtx().sync.project.background(props.project.worktree, hasBackground ? background : undefined)
        dialog.close()
        return
      }

      serverCtx().sync.project.meta(props.project.worktree, {
        name,
        icon: { color: store.color || undefined, override: store.iconOverride || undefined },
        background: hasBackground ? background : undefined,
        commands: { start: start || undefined },
      })
      serverCtx().sync.project.background(props.project.worktree, hasBackground ? background : undefined)
      dialog.close()
    },
  }))

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (save.isPending) return
    save.mutate()
  }

  return {
    store,
    setStore,
    folderName,
    defaultName,
    save,
    submit,
    drop,
    dragOver,
    dragLeave,
    inputChange,
    iconClick,
    backgroundDrop,
    backgroundDragOver,
    backgroundDragLeave,
    backgroundInputChange,
    backgroundClick,
    close() {
      dialog.close()
    },
    setIconInput(input: HTMLInputElement) {
      iconInput = input
    },
    setBackgroundInput(input: HTMLInputElement) {
      backgroundInput = input
    },
  }
}

const BACKGROUND_MAX_WIDTH = 2560
const BACKGROUND_MAX_BYTES = 2 * 1024 * 1024

async function compressImage(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => undefined)
  if (!bitmap) return
  const scale = Math.min(1, BACKGROUND_MAX_WIDTH / bitmap.width)
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext("2d")
  if (!context) {
    bitmap.close()
    return
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  let quality = 0.92
  let encoded = encodeCanvas(canvas, quality)
  while (encoded.length * 0.75 > BACKGROUND_MAX_BYTES && quality > 0.45) {
    quality -= 0.12
    encoded = encodeCanvas(canvas, quality)
  }
  return encoded
}

function encodeCanvas(canvas: HTMLCanvasElement, quality: number) {
  const webp = canvas.toDataURL("image/webp", quality)
  if (webp.startsWith("data:image/webp")) return webp
  return canvas.toDataURL("image/jpeg", quality)
}
