import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913090434_add_project_background",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`background_url\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`background_url_override\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`background_opacity\` integer;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`background_blur\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
