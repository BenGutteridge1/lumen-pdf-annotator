import { ANNOTATION_COLOUR_NAMES, AnnotationColour } from "./annotation-colour";
import { MARK_COLORS } from "./model";

let pickerSequence = 0;

export function mobileSelectionColours(
  palette: HTMLElement,
  chooseColour: (colour: AnnotationColour) => void,
  position: () => void,
): (colour: AnnotationColour) => void {
  const trigger = palette.createEl("button", {
    cls: "lumen-icon-button lumen-mobile-colour-trigger",
    attr: { type: "button", "aria-expanded": "false" },
  });
  trigger.createSpan({ cls: "lumen-mobile-colour-swatch", attr: { "aria-hidden": "true" } });
  const picker = palette.createDiv({
    cls: "lumen-mobile-colour-picker",
    attr: { id: `lumen-mobile-colour-picker-${++pickerSequence}`, role: "group", "aria-label": "Annotation colours", hidden: "" },
  });
  trigger.setAttribute("aria-controls", picker.id);

  let current: AnnotationColour | undefined;
  const alternatives = () => Array.from(picker.querySelectorAll("button"));
  const renderAlternatives = () => {
    picker.empty();
    for (const colour of MARK_COLORS) {
      if (colour === current) continue;
      const button = picker.createEl("button", {
        cls: "lumen-icon-button",
        attr: { type: "button", "aria-label": `Choose ${ANNOTATION_COLOUR_NAMES[colour]}` },
      });
      button.dataset.color = colour;
      button.style.setProperty("--mark-color", colour);
      button.createSpan({ cls: "lumen-mobile-colour-swatch", attr: { "aria-hidden": "true" } });
      button.addEventListener("click", event => {
        setOpen(false, event.detail === 0);
        chooseColour(colour);
      });
    }
  };
  const setOpen = (open: boolean, focus = false) => {
    if (open) renderAlternatives();
    picker.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) position();
    if (focus) (open ? alternatives()[0] : trigger)?.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", event => setOpen(picker.hidden, event.detail === 0));
  trigger.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (picker.hidden) setOpen(true);
    alternatives().at(event.key === "ArrowDown" ? 0 : -1)?.focus({ preventScroll: true });
  });
  palette.addEventListener("keydown", event => {
    if (picker.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, true);
      return;
    }
    const buttons = alternatives();
    const index = buttons.findIndex(button => button === event.target);
    if (index < 0) return;
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index + buttons.length - 1) % buttons.length
      : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
  });
  return colour => {
    if (current === colour) return;
    current = colour;
    trigger.dataset.color = colour;
    trigger.style.setProperty("--mark-color", colour);
    trigger.setAttribute("aria-label", `Annotation colour: ${ANNOTATION_COLOUR_NAMES[colour]}. Choose colour`);
    if (picker.hidden) return;
    const active = picker.ownerDocument.activeElement;
    const focusedIndex = alternatives().findIndex(button => button === active);
    renderAlternatives();
    alternatives()[focusedIndex]?.focus();
  };
}
