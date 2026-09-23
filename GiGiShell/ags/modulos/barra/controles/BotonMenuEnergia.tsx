import { openPowerMenu } from "../../../estado/shell"

export default function BotonMenuEnergia() {
  return (
    <button cssClasses={["bt-power"]} onClicked={() => openPowerMenu()}>
      <label label="󰐥" />
    </button>
  )
}
