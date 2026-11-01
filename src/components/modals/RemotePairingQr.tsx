import { useT } from '../../lib/i18n'
import styles from './RemotePairingQr.module.css'

type RemotePairingQrProps = {
  qrSvg: string
  pairingUrl: string
  expiresIn: number
}

export function RemotePairingQr({ qrSvg, pairingUrl, expiresIn }: RemotePairingQrProps) {
  const t = useT()

  return (
    <section className={styles.card}>
      <img
        className={styles.qr}
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
        alt={t('remote.qrAlt')}
      />
      <span className={styles.scanHint}>
        {t('remote.pairingCountdown', { seconds: String(expiresIn) })}
      </span>
      <div className={styles.urlBlock}>
        <span className={styles.metricLabel}>{t('remote.urlLabel')}</span>
        <code>{pairingUrl}</code>
      </div>
    </section>
  )
}
