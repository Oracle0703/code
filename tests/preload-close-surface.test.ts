import { describe, expect, it, vi } from 'vitest';
import { freezeRendererCloseSurface } from '../src/preload/close-surface';

describe('preload approved-close surface', () => {
  it('freezes and blurs the renderer synchronously, then restores its prior state on failure', () => {
    const surface = { inert: false };
    const focusedControl = { blur: vi.fn() };

    const release = freezeRendererCloseSurface(surface, focusedControl);

    expect(surface.inert).toBe(true);
    expect(focusedControl.blur).toHaveBeenCalledTimes(1);
    release();
    release();
    expect(surface.inert).toBe(false);
  });

  it('preserves an already inert surface when a response failure releases it', () => {
    const surface = { inert: true };
    const release = freezeRendererCloseSurface(surface, null);

    release();

    expect(surface.inert).toBe(true);
  });
});
