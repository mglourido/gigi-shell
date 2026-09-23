// modulos/notificaciones/rules/dedup.ts
// Pure dedup-key computation. Keys are lowercased and NUL-joined to avoid collisions.
import type { DedupKeySpec, NotifInput } from "./types.ts"

const SEP = " "

export function computeDedupKey(spec: DedupKeySpec, input: NotifInput): string {
  const app = input.appName.toLowerCase()
  const summary = input.summary.toLowerCase()
  const body = input.body.toLowerCase()
  if (typeof spec === "object") {
    return spec.template
      .replace(/\{app\}/g, app)
      .replace(/\{summary\}/g, summary)
      .replace(/\{body\}/g, body)
  }
  switch (spec) {
    case "app": return app
    case "app+summary": return [app, summary].join(SEP)
    case "app+summary+body": return [app, summary, body].join(SEP)
  }
}
