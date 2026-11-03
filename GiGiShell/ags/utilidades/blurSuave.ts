import { execAsync } from "ags/process"

let cola: Promise<unknown> = Promise.resolve()

/** Baja el blur global mientras `quien` esté activa (`hypr/gigishell/blur-suave.lua`). En cola: dos
 * `hyprctl` a la vez pueden llegar al revés. Un fallo no rompe nada: solo se ve otro blur. La promesa
 * se cumple cuando Hyprland ya tiene el cambio (o falló), y nunca se rechaza. */
export function blurSuave(quien: string, activar: boolean): Promise<void> {
  const paso = cola
    .then(() => execAsync(["hyprctl", "eval", `GiGiShell.blur_suave("${quien}", ${activar})`]))
    .then(() => {}, () => {})
  cola = paso
  return paso
}
