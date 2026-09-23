import {
  selectedIds,
  setSelectionMode,
  clearSelected,
} from "../store"

export default function PiePanel() {
  const haySeleccionadas = selectedIds((seleccionadas) => (seleccionadas?.size ?? 0) > 0)

  return (
    <box cssClasses={["np-footer"]} spacing={4} visible={haySeleccionadas}>
      <button
        cssClasses={["np-icon-btn", "danger"]}
        onClicked={() => {
          clearSelected()
          setSelectionMode(false)
        }}
      >
        <box spacing={3}>
          <label cssClasses={["np-btn-icon"]} label="󰆴" />
          <label
            cssClasses={["np-footer-count"]}
            label={selectedIds((seleccionadas) => String(seleccionadas.size))}
          />
        </box>
      </button>
    </box>
  )
}
