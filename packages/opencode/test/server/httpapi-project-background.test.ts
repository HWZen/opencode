import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  if (init.body) headers.set("content-type", "application/json")
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, { ...init, headers }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("project background HttpApi", () => {
  test("updates and reports background settings", async () => {
    await using tmp = await tmpdir({ git: true })

    const current = await request("/project/current", tmp.path)
    expect(current.status).toBe(200)
    const project = (await current.json()) as { id: string }

    const updated = await request(`/project/${project.id}`, tmp.path, {
      method: "PATCH",
      body: JSON.stringify({
        background: { override: "data:image/webp;base64,abc", opacity: 30, blur: 6 },
      }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      background: { override: "data:image/webp;base64,abc", opacity: 30, blur: 6 },
    })

    const list = await request("/project", tmp.path)
    const items = (await list.json()) as { id: string; background?: { opacity?: number } }[]
    expect(items.find((item) => item.id === project.id)?.background).toMatchObject({ opacity: 30 })
  })

  test("serves the configured background file", async () => {
    await using tmp = await tmpdir({ git: true })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await Bun.write(path.join(tmp.path, ".opencode", "background.png"), bytes)

    const current = await request("/project/current", tmp.path)
    const project = (await current.json()) as { id: string }
    await request(`/project/${project.id}`, tmp.path, {
      method: "PATCH",
      body: JSON.stringify({ background: { url: ".opencode/background.png" } }),
    })

    const response = await request(`/project/${project.id}/background`, tmp.path)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  test("rejects background paths outside the worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const current = await request("/project/current", tmp.path)
    const project = (await current.json()) as { id: string }
    await request(`/project/${project.id}`, tmp.path, {
      method: "PATCH",
      body: JSON.stringify({ background: { url: "../secret.txt" } }),
    })

    const response = await request(`/project/${project.id}/background`, tmp.path)
    expect(response.status).toBe(404)
  })

  test("returns 404 when no background is configured", async () => {
    await using tmp = await tmpdir({ git: true })
    const current = await request("/project/current", tmp.path)
    const project = (await current.json()) as { id: string }

    const response = await request(`/project/${project.id}/background`, tmp.path)
    expect(response.status).toBe(404)
  })
})
