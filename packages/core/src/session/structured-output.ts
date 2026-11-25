export * as SessionStructuredOutput from "./structured-output.js"

import { Tool as ToolSchema } from "@opencode/schema/tool"
import { OUTPUT_TOOL, type Output } from "@opencode/schema/prompt"
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database.js"
import { Tool } from "../tool.js"
import { definition, execute } from "../tool/runtime.js"
import { SessionHistory } from "./history.js"
import { SessionMessageTable } from "./sql.js"
import type { SessionSchema } from "./schema.js"

/** The tool the agent calls to return its answer; its input schema is the caller's schema. */
export const NAME = OUTPUT_TOOL

export const DEFAULT_RETRIES = 2

/** Marks the synthetic message that asks the agent to call the tool after it ended its turn without doing so. */
export const REMINDER_METADATA = { structuredOutput: "required" } as const

export const REMINDER = `Your last response did not call the ${NAME} tool. Return your final answer by calling ${NAME} with arguments that match its schema. Do not reply with plain text.`

export const INSTRUCTIONS = `Your final answer for this task must be returned by calling the ${NAME} tool, whose arguments must match its schema. The turn only ends once that call is accepted. If a call is rejected, read the validation errors and call the tool again with corrected arguments.`

/** Why a schema cannot be offered to a model as tool input. Providers require tool input to be a JSON object. */
export const unsupported = (schema: Output["schema"]) =>
  schema.type === "object" ? undefined : 'output.schema must describe an object (its root must have "type": "object")'

export const description = (schema: Output["schema"]) =>
  typeof schema.description === "string" && schema.description !== ""
    ? `Return the final answer. ${schema.description}`
    : "Return the final answer, as arguments that match this tool's schema."

const tool = (output: Output) =>
  ({
    name: NAME,
    description: description(output.schema),
    input: output.schema,
    execute: () => Effect.succeed({ content: "Answer accepted." }),
  }) satisfies ToolSchema.Info

/**
 * Offers the structured-output tool for one request. It is not a registered tool: it exists only while the active
 * turn asks for it, so the registry stays the same for every other turn in the Location.
 */
export const attach = (tools: Tool.Snapshot, output: Output): Tool.Snapshot => {
  const info = tool(output)
  return {
    ...tools,
    definitions: [...tools.definitions, definition(info)],
    execute: (input) =>
      input.call.name === NAME
        ? execute(info, input.call.input, {
            sessionID: input.sessionID,
            agent: input.agent,
            messageID: input.messageID,
            id: ToolSchema.CallID.make(input.call.id),
            progress: input.progress ?? (() => Effect.void),
            cancel: input.cancel,
          })
        : tools.execute(input),
  }
}

export type Progress =
  | { readonly status: "inactive" }
  | { readonly status: "accepted" }
  | { readonly status: "pending"; readonly output: Output; readonly corrections: number }

/**
 * Where the active turn stands. The turn starts at the newest user message, which owns the contract. This reads
 * history instead of keeping state, so it holds across retries, restarts, and compaction of earlier messages.
 */
export const progress = Effect.fn("SessionStructuredOutput.progress")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const [row] = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .all()
    .pipe(Effect.orDie)
  if (!row) return { status: "inactive" } satisfies Progress
  const [user] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  if (user?.type !== "user" || !user.output) return { status: "inactive" } satisfies Progress
  const after = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        gt(SessionMessageTable.seq, row.seq),
        inArray(SessionMessageTable.type, ["assistant", "synthetic"]),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const turn = yield* SessionHistory.decodeMessageRows(db, after).pipe(Effect.orDie)
  const calls = turn.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => (part.type === "tool" && part.name === NAME ? [part.state.status] : []))
      : [],
  )
  if (calls.includes("completed")) return { status: "accepted" } satisfies Progress
  const reminders = turn.filter(
    (message) =>
      message.type === "synthetic" && message.metadata?.structuredOutput === REMINDER_METADATA.structuredOutput,
  ).length
  return {
    status: "pending",
    output: user.output,
    corrections: reminders + calls.filter((status) => status === "error").length,
  } satisfies Progress
})

export const retries = (output: Output) => output.retries ?? DEFAULT_RETRIES
