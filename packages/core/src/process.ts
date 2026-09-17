import { Context, Duration, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner, POST_EXIT_GRACE_MS } from "./cross-spawn-spawner"
import { makeGlobalNode } from "./effect/app-node"

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()("AppProcessError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const detail =
      this.stderr?.trim() || (this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause))
    const status = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`
    return `Command failed${status}: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

export interface RunOptions {
  readonly combineOutput?: boolean
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
}

export interface RunStreamOptions {
  readonly signal?: AbortSignal
  readonly includeStderr?: boolean
  readonly okExitCodes?: ReadonlyArray<number>
  readonly maxErrorBytes?: number
}

export interface RunResult {
  readonly command: string
  readonly exitCode: number
  readonly output?: Buffer
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly outputTruncated?: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type Interface = ChildProcessSpawner["Service"] & {
  readonly run: (command: ChildProcess.Command, options?: RunOptions) => Effect.Effect<RunResult, AppProcessError>
  readonly runStream: (
    command: ChildProcess.Command,
    options?: RunStreamOptions,
  ) => Stream.Stream<string, AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AppProcess") {}

export const requireSuccess = (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new AppProcessError({
          command: result.command,
          exitCode: result.exitCode,
          stderr: result.stderr.toString("utf8"),
        }),
      )

export const requireExitIn =
  (codes: ReadonlyArray<number>) =>
  (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
    codes.includes(result.exitCode)
      ? Effect.succeed(result)
      : Effect.fail(
          new AppProcessError({
            command: result.command,
            exitCode: result.exitCode,
            stderr: result.stderr.toString("utf8"),
          }),
        )

const describeCommand = (command: ChildProcess.Command): string => {
  if (command._tag === "StandardCommand") {
    return command.args.length ? `${command.command} ${command.args.join(" ")}` : command.command
  }
  return `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

const wrapError = (description: string, cause: unknown): AppProcessError =>
  cause instanceof AppProcessError ? cause : new AppProcessError({ command: description, cause })

export const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError(signal)))
      return
    }
    const onabort = () => resume(Effect.fail(abortError(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })

const normalizeStdin = (
  input: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<Uint8Array, PlatformError> =>
  typeof input === "string"
    ? Stream.make(new TextEncoder().encode(input))
    : input instanceof Uint8Array
      ? Stream.make(input)
      : input

type Acc = { chunks: Uint8Array[]; bytes: number; truncated: boolean }

const pushChunk = (acc: Acc, chunk: Uint8Array, maxOutputBytes: number | undefined): Acc => {
  if (maxOutputBytes === undefined) {
    acc.chunks.push(chunk)
    acc.bytes += chunk.length
    return acc
  }
  const remaining = maxOutputBytes - acc.bytes
  if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
  acc.bytes += chunk.length
  acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
  return acc
}

export const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError>, maxOutputBytes: number | undefined) =>
  Stream.runFold(
    stream,
    (): Acc => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
    (acc, chunk) => pushChunk(acc, chunk, maxOutputBytes),
  ).pipe(Effect.map((x) => ({ buffer: Buffer.concat(x.chunks), truncated: x.truncated })))

/**
 * Like collectStream, but anchored to process exit instead of pipe EOF: a descendant that
 * inherited the stdio pipe (dev server, daemon, background child) keeps it open, so waiting
 * for EOF can block forever. Output is read concurrently, EOF is still preferred, and the
 * read is stopped at most POST_EXIT_GRACE_MS after the direct child exits.
 */
export const collectBounded = (
  handle: ChildProcessHandle,
  stream: Stream.Stream<Uint8Array, PlatformError>,
  maxOutputBytes: number | undefined,
) =>
  Effect.gen(function* () {
    const acc = yield* Ref.make<Acc>({ chunks: [], bytes: 0, truncated: false })
    const reader = yield* Effect.forkScoped(
      Stream.runForEach(stream, (chunk) => Ref.update(acc, (a) => pushChunk(a, chunk, maxOutputBytes))),
    )
    yield* handle.exitCode.pipe(Effect.ignore)
    yield* Effect.raceAll([
      Fiber.join(reader).pipe(Effect.asVoid, Effect.ignore),
      Effect.sleep(`${POST_EXIT_GRACE_MS} millis`).pipe(Effect.asVoid),
    ])
    yield* Fiber.interrupt(reader).pipe(Effect.ignore)
    const a = yield* Ref.get(acc)
    return { buffer: Buffer.concat(a.chunks), truncated: a.truncated }
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const runCommand = (command: ChildProcess.Command, options?: RunOptions) => {
      const description = describeCommand(command)
      const collect = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          if (options?.combineOutput) {
            const [output, exitCode] = yield* Effect.all(
              [collectBounded(handle, handle.all, options.maxOutputBytes), handle.exitCode],
              { concurrency: "unbounded" },
            )
            return {
              command: description,
              exitCode,
              output: output.buffer,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              outputTruncated: output.truncated,
              stdoutTruncated: false,
              stderrTruncated: false,
            } satisfies RunResult
          }
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectBounded(handle, handle.stdout, options?.maxOutputBytes),
              collectBounded(handle, handle.stderr, options?.maxErrorBytes),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return {
            command: description,
            exitCode,
            stdout: stdout.buffer,
            stderr: stderr.buffer,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          } satisfies RunResult
        }),
      )
      const timed = options?.timeout
        ? Effect.timeoutOrElse(collect, {
            duration: options.timeout,
            orElse: () => Effect.fail(new AppProcessError({ command: description, cause: new Error("Timed out") })),
          })
        : collect
      const aborted = options?.signal
        ? timed.pipe(
            Effect.raceFirst(
              waitForAbort(options.signal).pipe(Effect.mapError((cause) => wrapError(description, cause))),
            ),
          )
        : timed
      return aborted.pipe(Effect.catch((cause) => Effect.fail(wrapError(description, cause))))
    }

    const run = Effect.fn("AppProcess.run")(function* (command: ChildProcess.Command, options?: RunOptions) {
      if (options?.stdin === undefined) return yield* runCommand(command, options)
      if (command._tag !== "StandardCommand") {
        return yield* new AppProcessError({
          command: describeCommand(command),
          cause: new Error("stdin option only supports StandardCommand; received PipedCommand"),
        })
      }
      const next = ChildProcess.make(command.command, command.args, {
        ...command.options,
        stdin: normalizeStdin(options.stdin),
      })
      return yield* runCommand(next, options)
    })

    const runStream = (
      command: ChildProcess.Command,
      options?: RunStreamOptions,
    ): Stream.Stream<string, AppProcessError> => {
      const description = describeCommand(command)
      const okExitCodes = options?.okExitCodes
      const built: Stream.Stream<string, AppProcessError | PlatformError> = Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          const stderrFiber = yield* Effect.forkScoped(
            collectStream(handle.stderr, options?.maxErrorBytes).pipe(Effect.map((x) => x.buffer.toString("utf8"))),
          )
          const source = options?.includeStderr === true ? handle.all : handle.stdout
          const lines = source.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
          )
          const tail = Stream.unwrap(
            Effect.gen(function* () {
              const code = yield* handle.exitCode
              if (okExitCodes && okExitCodes.length > 0 && !okExitCodes.includes(code)) {
                const stderr = yield* Fiber.join(stderrFiber)
                return Stream.fail(new AppProcessError({ command: description, exitCode: code, stderr }))
              }
              return Stream.empty
            }),
          )
          return Stream.concat(lines, tail) as Stream.Stream<string, AppProcessError | PlatformError>
        }),
      )
      const mapped = built.pipe(
        Stream.catch((cause): Stream.Stream<string, AppProcessError> => Stream.fail(wrapError(description, cause))),
      )
      if (!options?.signal) return mapped
      const signal = options.signal
      return mapped.pipe(
        Stream.interruptWhen(waitForAbort(signal).pipe(Effect.mapError((cause) => wrapError(description, cause)))),
      )
    }

    return Service.of({ ...spawner, run, runStream })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node] })

export * as AppProcess from "./process"
