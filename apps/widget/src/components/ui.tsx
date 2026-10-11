// Form primitives shared by the widget's screens. Each one carries its own
// label, hint and error wiring so a screen cannot forget it.

import type { InputHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";

export type FieldError = { field: string; message: string };

export function errorFor(errors: FieldError[], field: string): string | undefined {
  return errors.find((e) => e.field === field)?.message;
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

export function InlineError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="lq-error">
      <span className="lq-sr">Error: </span>
      {message}
    </p>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
};

export function TextField({ id, label, hint, error, inputRef, ...input }: TextFieldProps) {
  return (
    <div className="lq-field">
      <label htmlFor={id} className="lq-label">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="lq-hint">
          {hint}
        </p>
      )}
      <input
        id={id}
        ref={inputRef}
        className="lq-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...input}
      />
      <InlineError id={id} message={error} />
    </div>
  );
}

type RadioGroupProps<T extends string> = {
  /** Also the id of the first radio, so an error summary link can focus the group. */
  id: string;
  legend: string;
  hint?: string;
  error?: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange(value: T): void;
};

export function RadioGroup<T extends string>({ id, legend, hint, error, options, value, onChange }: RadioGroupProps<T>) {
  return (
    <fieldset className="lq-fieldset" aria-describedby={describedBy(id, hint, error)}>
      <legend className="lq-label">{legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className="lq-hint">
          {hint}
        </p>
      )}
      {options.map((option, index) => (
        <label key={option.value} className="lq-radio">
          <input
            type="radio"
            id={index === 0 ? id : undefined}
            name={id}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
      <InlineError id={id} message={error} />
    </fieldset>
  );
}

/**
 * The list of what is wrong with a form, announced when it appears and
 * focused by the form after a failed submit. Each entry moves focus to its
 * field, whose own error text is linked with aria-describedby.
 */
export function ErrorSummary({ errors, summaryRef }: { errors: FieldError[]; summaryRef: Ref<HTMLDivElement> }) {
  if (errors.length === 0) return null;
  const focusField = (event: MouseEvent, field: string) => {
    event.preventDefault();
    document.getElementById(field)?.focus();
  };
  return (
    <div className="lq-alert" role="alert" tabIndex={-1} ref={summaryRef}>
      <h2 className="lq-alert-title">{errors.length === 1 ? "There is a problem" : `There are ${errors.length} problems`}</h2>
      <ul>
        {errors.map((error) => (
          <li key={error.field}>
            <a href={`#${error.field}`} onClick={(event) => focusField(event, error.field)}>
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ButtonProps = {
  children: ReactNode;
  /** Shown in place of the label while the request runs. */
  busyLabel?: string;
  busy?: boolean;
  variant?: "primary" | "secondary" | "link";
  type?: "submit" | "button";
  onClick?(): void;
};

/**
 * Stays focusable while busy (aria-disabled, not disabled), so focus is not
 * thrown to the top of the document mid-request.
 */
export function Button({ children, busyLabel, busy = false, variant = "primary", type = "button", onClick }: ButtonProps) {
  return (
    <button
      type={type}
      className={`lq-button lq-button-${variant}`}
      aria-disabled={busy || undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.();
      }}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}
