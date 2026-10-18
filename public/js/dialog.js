import { h, icon, keepFocusOnRerender, uid } from './dom.js';
import { button, withBusy } from './ui.js';

export const isDialogOpen = () => document.querySelector('dialog[open]') !== null;

/** Dialogs belong to the page they were opened on. */
export function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

/**
 * Opens a modal form (native <dialog>: focus is trapped, Escape cancels). `onSubmit(form)` runs
 * on submit; if it throws, its message is shown inside the dialog, which stays open so the
 * merchant can correct the input. Resolves with onSubmit's result (true if it returns nothing),
 * or null when cancelled. API calls made in `onSubmit` should pass `toastErrors: false`.
 */
export function formDialog({
  title,
  intro,
  content = [],
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  tone = 'primary',
  onSubmit,
  initialFocus,
}) {
  return new Promise((resolve) => {
    const titleId = uid('dialog-title');
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submit = button(submitLabel, { variant: tone, type: 'submit' });
    const cancel = button(cancelLabel, { onClick: () => finish(null) });
    const form = h(
      'form',
      { class: 'dialog-form' },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { id: titleId, class: 'dialog-title' }, title),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': 'Close',
            onclick: () => finish(null),
          },
          icon('close', { size: 18 }),
        ),
      ),
      h(
        'div',
        { class: 'dialog-body' },
        intro && h('div', { class: 'dialog-intro' }, intro),
        content,
        error,
      ),
      h('div', { class: 'dialog-footer' }, cancel, submit),
    );
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId }, form);
    const previousFocus = document.activeElement;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (previousFocus?.isConnected) {
        previousFocus.focus();
        // The page usually reloads after a save, replacing the button that opened the dialog.
        if (result !== null) keepFocusOnRerender(previousFocus);
      }
      resolve(result);
    }

    // Closed from outside (the merchant navigated away): treat as cancelled.
    dialog.addEventListener('close', () => finish(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      // Don't hide a change that is still being saved: its outcome would go unseen.
      if (!submit.classList.contains('is-busy')) finish(null);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      try {
        const result = await withBusy(submit, async () => (onSubmit ? onSubmit(form) : true));
        finish(result === undefined ? true : result);
      } catch (err) {
        error.replaceChildren(
          icon('error'),
          h('span', {}, err?.message || 'Something went wrong.'),
        );
        error.hidden = false;
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    const target =
      initialFocus?.(dialog) ??
      dialog.querySelector('.dialog-body input, .dialog-body select, .dialog-body textarea') ??
      // For destructive actions, Enter must not confirm by accident.
      (tone === 'critical' ? cancel : submit);
    target.focus();
  });
}

/** Asks for confirmation; resolves true once `onConfirm` (optional) has succeeded. */
export async function confirmDialog({ title, message, confirmLabel, tone = 'primary', onConfirm }) {
  const result = await formDialog({
    title,
    intro: message,
    submitLabel: confirmLabel,
    tone,
    onSubmit: onConfirm,
  });
  return result !== null;
}
