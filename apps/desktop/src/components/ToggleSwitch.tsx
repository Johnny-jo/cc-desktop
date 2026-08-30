import React from "react";

export type ToggleSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
};

/** Shared compact switch for genuine on/off settings. */
export function ToggleSwitch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  className = "",
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`ui-switch${className ? ` ${className}` : ""}`}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="ui-switch-knob" aria-hidden />
    </button>
  );
}
