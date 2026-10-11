"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import {
  Button,
  Dialog,
  FieldError,
  Heading,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  Text,
  TextField,
  type ButtonProps,
} from "react-aria-components";
import type { FieldError as FormError } from "@/lib/pricing-form";

// ---- page heading: title and focus on every route change (2.4.2, 2.4.3)

let lastPath: string | null = null;

/** For a page without a PageHeading (sign-in), so the page after it still takes focus. */
export function noteRoute(pathname: string) {
  lastPath = pathname;
}

export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    // Not on the first page of a visit: focus then belongs at the top of the document.
    if (lastPath !== null && lastPath !== pathname) ref.current?.focus();
    lastPath = pathname;
  }, [pathname]);

  return (
    <div className="page-heading">
      {/* React hoists this into the head; Next's route announcer reads it out. */}
      <title>{`${title} · Instant Lawn Quote`}</title>
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {children}
    </div>
  );
}

// ---- fields

type TextInputProps = {
  id?: string;
  label: string;
  /** The label is still the accessible name; a table column header is the visible one. */
  hideLabel?: boolean;
  description?: string;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password" | "url";
  inputMode?: "numeric" | "decimal" | "text";
  autoComplete?: string;
  isRequired?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
};

export function TextInput({ id, label, hideLabel, description, error, value, onChange, type = "text", inputMode, autoComplete, isRequired, className, inputRef }: TextInputProps) {
  return (
    <TextField
      id={id}
      className={`field ${className ?? ""}`}
      value={value}
      onChange={onChange}
      type={type}
      inputMode={inputMode}
      autoComplete={autoComplete}
      isRequired={isRequired}
      isInvalid={!!error}
      validationBehavior="aria"
      aria-label={hideLabel ? label : undefined}
    >
      {!hideLabel && <Label>{label}</Label>}
      <Input ref={inputRef} className="input" spellCheck={false} />
      {description && (
        <Text slot="description" className="hint">
          {description}
        </Text>
      )}
      <FieldError className="field-error">{error}</FieldError>
    </TextField>
  );
}

type SelectFieldProps = {
  id?: string;
  label: string;
  hideLabel?: boolean;
  error?: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ id: string; label: string }>;
  placeholder?: string;
  className?: string;
};

export function SelectField({ id, label, hideLabel, error, value, onChange, options, placeholder = "Choose…", className }: SelectFieldProps) {
  return (
    <Select
      className={`field ${className ?? ""}`}
      selectedKey={value === "" ? null : value}
      onSelectionChange={(key) => onChange(key === null ? "" : String(key))}
      isInvalid={!!error}
      validationBehavior="aria"
      placeholder={placeholder}
      aria-label={hideLabel ? label : undefined}
    >
      {!hideLabel && <Label>{label}</Label>}
      <Button id={id} className="select-button">
        <SelectValue />
        <span aria-hidden="true" className="select-caret">
          ▾
        </span>
      </Button>
      <FieldError className="field-error">{error}</FieldError>
      <Popover className="popover">
        <ListBox className="listbox" items={options}>
          {(option) => (
            <ListBoxItem id={option.id} className="listbox-item">
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

// ---- error summary (3.3.1): focusable, lists every problem, each a link to its field

export function ErrorSummary({ errors, summaryRef, title }: { errors: FormError[]; summaryRef: Ref<HTMLDivElement>; title?: string }) {
  if (errors.length === 0) return null;
  return (
    <div ref={summaryRef} tabIndex={-1} role="alert" className="error-summary">
      <h2>{title ?? (errors.length === 1 ? "There is 1 problem to fix" : `There are ${errors.length} problems to fix`)}</h2>
      <ul>
        {errors.map((error) => (
          <li key={`${error.fieldId}-${error.message}`}>
            <a
              href={`#${error.fieldId}`}
              onClick={(event) => {
                event.preventDefault();
                const field = document.getElementById(error.fieldId);
                field?.scrollIntoView({ block: "center" });
                field?.focus();
              }}
            >
              {error.label}: {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const errorFor = (errors: FormError[], id: string) => errors.find((e) => e.fieldId === id)?.message;

// ---- buttons

/**
 * A button that stays focusable while its action runs and ignores presses
 * until it ends. React Aria's own `isPending` announces by pointing a live
 * region at the button's id; when the action ends by removing the button
 * (signing in, publishing) that reference dangles and fails axe. The result of
 * every action here is announced by a status region instead.
 */
export function BusyButton({ isBusy, onPress, children, ...props }: Omit<ButtonProps, "children" | "isPending"> & { isBusy?: boolean; children: ReactNode }) {
  return (
    <Button {...props} data-busy={isBusy || undefined} onPress={isBusy ? undefined : onPress}>
      {children}
      {isBusy && <span className="visually-hidden">, working</span>}
    </Button>
  );
}

// ---- dialogs (2.4.3, 2.1.2): focus goes in on open, Escape closes, focus returns to the trigger

type ConfirmDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
  danger?: boolean;
  error?: string | null;
};

export function ConfirmDialog({ isOpen, onClose, title, children, confirmLabel, onConfirm, isPending, danger, error }: ConfirmDialogProps) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={(open) => !open && onClose()} isDismissable className="modal-overlay">
      <Modal className="modal">
        <Dialog role="alertdialog" className="dialog">
          <Heading slot="title">{title}</Heading>
          {children}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button className="btn" onPress={onClose}>
              Cancel
            </Button>
            <BusyButton className={danger ? "btn danger" : "btn primary"} onPress={onConfirm} isBusy={isPending}>
              {confirmLabel}
            </BusyButton>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// ---- toasts (4.1.3): polite, six seconds, and never the only copy of a result

type Toast = { id: number; message: string };
const ToastContext = createContext<(message: string) => void>(() => {});
const TOAST_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const announce = useCallback(
    (message: string) => {
      const id = ++nextId.current;
      setToasts((list) => [...list, { id, message }]);
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={announce}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <span>{toast.message}</span>
            <Button className="btn quiet" aria-label="Dismiss message" onPress={() => dismiss(toast.id)}>
              <span aria-hidden="true">✕</span>
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---- status chips (1.4.1): text and a shape, never color alone

const CHIPS = {
  submitted: { label: "New", tone: "new", shape: <circle cx="6" cy="6" r="4.5" /> },
  accepted: { label: "Accepted", tone: "ok", shape: <path d="M1.5 6.5l3 3 6-7" fill="none" strokeWidth="2" stroke="currentColor" /> },
  declined: { label: "Declined", tone: "no", shape: <path d="M2 2l8 8M10 2l-8 8" fill="none" strokeWidth="2" stroke="currentColor" /> },
  expired: { label: "Expired", tone: "old", shape: <rect x="1.5" y="5" width="9" height="2" /> },
  current: { label: "Current", tone: "ok", shape: <path d="M1.5 6.5l3 3 6-7" fill="none" strokeWidth="2" stroke="currentColor" /> },
  draft: { label: "Draft", tone: "new", shape: <circle cx="6" cy="6" r="4" fill="none" strokeWidth="2" stroke="currentColor" /> },
  previous: { label: "Previous", tone: "old", shape: <rect x="1.5" y="5" width="9" height="2" /> },
} as const;

export type ChipKind = keyof typeof CHIPS;

export function StatusChip({ kind }: { kind: ChipKind }) {
  const chip = CHIPS[kind];
  return (
    <span className={`chip chip-${chip.tone}`}>
      <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
        {chip.shape}
      </svg>
      {chip.label}
    </span>
  );
}

export const leadStatusLabel = (status: "submitted" | "accepted" | "declined" | "expired") => CHIPS[status].label;

// ---- loading and failure

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="muted">
      Loading {what}&hellip;
    </p>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="error-summary">
      <p>{message}</p>
      <Button className="btn" onPress={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Scrolls in its own container at narrow widths (1.4.10) and can be scrolled from the keyboard. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable to be scrolled by keyboard
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
