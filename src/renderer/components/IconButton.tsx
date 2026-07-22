import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
  tooltipSide?: 'bottom' | 'left' | 'right';
}

export function IconButton({
  label,
  children,
  active = false,
  tooltipSide = 'bottom',
  className = '',
  type = 'button',
  ...buttonProps
}: IconButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={`icon-button ${active ? 'is-active' : ''} ${className}`.trim()}
      aria-label={label}
      aria-pressed={active || undefined}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
    >
      {children}
    </button>
  );
}
