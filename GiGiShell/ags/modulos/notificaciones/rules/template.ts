// modulos/notificaciones/rules/template.ts
// Pure templating: replace {key} with fields[key]; unknown keys stay literal. No imports.

export function applyTemplate(template: string, fields: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : whole,
  )
}
