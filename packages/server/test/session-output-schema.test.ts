import path from "node:path"
import { expect } from "bun:test"
import { isInvalidRequestError, OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const serve = (database: string) =>
  ServerFetch.make({
    app: { version: "test" },
    database: { path: database },
    config: { directory: path.dirname(database), project: false, content: "{}" },
    models: { fetch: false },
    fs: { filewatcher: false },
  })

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

it.live("rejects an unusable output schema with a 400 naming the field, and stores a usable one", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-output-schema-")).path
    yield* Effect.gen(function* () {
      const opencode = client(yield* serve(path.join(dir, "opencode.db")))

      yield* Effect.promise(async () => {
        const session = await opencode.session.create({ title: "Output schema" })

        // Providers need object tool input, so a schema with any other root is refused before the agent starts.
        const rejected = await opencode.session
          .prompt({ sessionID: session.id, text: "Hi", output: { schema: { type: "array" } }, resume: false })
          .then(
            () => undefined,
            (error: unknown) => error,
          )
        expect(isInvalidRequestError(rejected)).toBe(true)
        expect(rejected).toMatchObject({ field: "output", message: expect.stringContaining("type") })
        expect(await opencode.session.inbox.list({ sessionID: session.id })).toEqual([])

        const output = {
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
          retries: 3,
        }
        const queued = await opencode.session.prompt({ sessionID: session.id, text: "Hi", output, resume: false })
        expect(queued).toMatchObject({ payload: { output } })
        expect(await opencode.session.inbox.list({ sessionID: session.id })).toMatchObject([
          { id: queued.id, payload: { output } },
        ])
      })
    })
  }).pipe(Effect.scoped),
)
