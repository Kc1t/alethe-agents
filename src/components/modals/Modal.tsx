import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { useT } from '../../lib/i18n'
import styles from './Modal.module.css'

type Props = {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}

/** Wrapper Radix Dialog padronizado pra todos os modais do app. */
export function Modal({ open, onClose, title, children, footer, width = 440 }: Props) {
  const t = useT()
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          style={{ width }}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // foca o primeiro input ao invés do botão close
            const root = e.currentTarget as HTMLElement | null
            const input = root?.querySelector<HTMLElement>('input,textarea,[data-autofocus]')
            if (input) {
              e.preventDefault()
              input.focus()
            }
          }}
        >
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label={t('common.close')} className={styles.close}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
