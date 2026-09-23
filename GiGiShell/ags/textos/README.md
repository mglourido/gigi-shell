# Textos de Ajustes

Los textos visibles del panel de Ajustes viven en `ajustes/`, separados del
código TypeScript/TSX. Hay un JSON por apartado para que puedan editarse sin
tocar la lógica de la interfaz ni los servicios.

- Conserva las claves y cambia únicamente sus valores.
- JSON no admite comentarios ni comas después del último elemento.
- Los fragmentos `{{nombre}}` son valores dinámicos; no los traduzcas ni los
  elimines si quieres que el dato siga apareciendo.
- Tras editar un JSON, reinicia AGS con `ags quit` y
  `ags run ~/.config/ags/app.ts`.
- `ags bundle app.ts /tmp/gigios.js`, ejecutado desde `ags/`, valida todos los
  JSON importados y sus rutas.
