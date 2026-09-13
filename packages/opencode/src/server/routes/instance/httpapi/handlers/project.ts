import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import path from "path"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    const background = Effect.fn("ProjectHttpApi.background")(function* (ctx: { params: { projectID: ProjectV2.ID } }) {
      const info = yield* svc.get(ctx.params.projectID)
      if (!info)
        return yield* new ProjectNotFoundError({ projectID: ctx.params.projectID, message: "Project not found" })
      const url = info.background?.url
      if (!url) return yield* new HttpApiError.NotFound({})
      // Non-git projects share the `global` row and keep worktree "/"; discovered
      // paths are relative to the directory that registered them.
      const root = info.worktree === "/" ? (yield* InstanceState.context).directory : info.worktree
      const file = path.resolve(root, url)
      if (!FSUtil.contains(root, file)) return yield* new HttpApiError.NotFound({})
      const bytes = yield* FSUtil.Service.use((fs) => fs.readFile(file)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!bytes) return yield* new HttpApiError.NotFound({})
      return bytes
    })

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("background", background)
      .handle("directories", directories)
  }),
)
