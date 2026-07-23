export interface RendererCloseSurface {
  inert: boolean;
}

export interface RendererFocusedControl {
  blur(): void;
}

export function freezeRendererCloseSurface(
  surface: RendererCloseSurface,
  focusedControl: RendererFocusedControl | null,
): () => void {
  const previousInert = surface.inert;
  surface.inert = true;
  focusedControl?.blur();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    surface.inert = previousInert;
  };
}
