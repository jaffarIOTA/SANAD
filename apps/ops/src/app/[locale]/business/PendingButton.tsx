'use client';

/**
 * A form's submit button that knows its form is being sent: while the server
 * action runs it shows a spinner, says it is busy, and cannot be pressed
 * again — so a slow rail is not clicked twice and the officer sees that
 * something is happening. The server's idempotency stands regardless; this is
 * the courtesy in front of it.
 */
import type { ReactElement, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function PendingButton({
  className,
  children,
  disabled,
  name,
  value,
  title,
}: {
  readonly className: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly value?: string;
  readonly title?: string;
}): ReactElement {
  const { pending, data } = useFormStatus();
  // With several submit buttons in one form, only the one pressed spins.
  const mine = pending && (name === undefined || data?.get(name) === value);
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled === true || pending}
      aria-busy={mine}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...(title === undefined ? {} : { title })}
    >
      {mine ? <span aria-hidden className="spinner" /> : null}
      {children}
    </button>
  );
}
