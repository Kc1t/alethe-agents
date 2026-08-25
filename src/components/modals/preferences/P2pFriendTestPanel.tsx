import { Check, Copy, Radio, Wifi } from 'lucide-react'
import { useState } from 'react'

import { useP2pFriendTest } from '../../../hooks/useP2pFriendTest'
import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import styles from './P2pFriendTestPanel.module.css'
import { SettingsSection } from './primitives'

export function P2pFriendTestPanel() {
  const t = useT()
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const [copied, setCopied] = useState(false)
  const {
    log,
    myCode,
    friendCode,
    setFriendCode,
    verifiedFriend,
    sharedInvitationId,
    setSharedInvitationId,
    sharedSessionId,
    setSharedSessionId,
    rendezvousConnected,
    localCandidate,
    remoteCandidate,
    connectedRemoteDeviceId,
    loadMyCode,
    verifyFriend,
    connect,
    sendInvite,
    checkIncoming,
    shareMyCandidate,
    tryDirectConnect,
  } = useP2pFriendTest()

  const copyMyCode = async () => {
    if (!myCode) return
    await navigator.clipboard.writeText(myCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <SettingsSection
      id="p2p-friend-test"
      title={t('p2pTest.title')}
      description={t('p2pTest.description')}
    >
      <div className={styles.stack}>
        <div className={styles.step}>
          <span className={styles.stepTitle}>{t('p2pTest.step1')}</span>
          <div className={styles.row}>
            <button type="button" className={controls.btn} onClick={() => void loadMyCode()}>
              {t('p2pTest.generateCode')}
            </button>
            {myCode ? (
              <button type="button" className={controls.btn} onClick={() => void copyMyCode()}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {t('p2pTest.copy')}
              </button>
            ) : null}
          </div>
          {myCode ? <code className={styles.codeBox}>{myCode}</code> : null}
        </div>

        <div className={styles.step}>
          <span className={styles.stepTitle}>{t('p2pTest.step2')}</span>
          <textarea
            className={styles.textarea}
            value={friendCode}
            onChange={(event) => setFriendCode(event.target.value)}
            placeholder={t('p2pTest.pasteFriendCode')}
            spellCheck={false}
          />
          <button
            type="button"
            className={controls.btn}
            disabled={!friendCode.trim()}
            onClick={() => void verifyFriend()}
          >
            {t('p2pTest.verify')}
          </button>
          {verifiedFriend ? (
            <div className={styles.okRow}>
              <Check size={13} /> {t('p2pTest.friendVerified', { device: verifiedFriend.deviceId })}
            </div>
          ) : null}
        </div>

        <div className={styles.step}>
          <span className={styles.stepTitle}>{t('p2pTest.step3')}</span>
          <button type="button" className={controls.btn} onClick={() => void connect()}>
            <Radio size={13} />
            {rendezvousConnected ? t('p2pTest.connected') : t('p2pTest.connect')}
          </button>
        </div>

        <div className={styles.step}>
          <span className={styles.stepTitle}>{t('p2pTest.step4')}</span>
          <label className={styles.fieldLabel}>
            {t('p2pTest.invitationIdLabel')}
            <input
              className={controls.input}
              value={sharedInvitationId}
              onChange={(event) => setSharedInvitationId(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className={controls.btn}
            disabled={!verifiedFriend || !activeProjectId}
            onClick={() => activeProjectId && void sendInvite(activeProjectId)}
          >
            {t('p2pTest.sendInvite')}
          </button>
        </div>

        <div className={styles.step}>
          <span className={styles.stepTitle}>{t('p2pTest.step5')}</span>
          <label className={styles.fieldLabel}>
            {t('p2pTest.sessionIdLabel')}
            <input
              className={controls.input}
              value={sharedSessionId}
              onChange={(event) => setSharedSessionId(event.target.value)}
              spellCheck={false}
              placeholder="teste-1"
            />
          </label>
          <div className={styles.row}>
            <button
              type="button"
              className={controls.btn}
              disabled={!verifiedFriend}
              onClick={() => void shareMyCandidate()}
            >
              {t('p2pTest.shareCandidate')}
            </button>
            <button type="button" className={controls.btn} onClick={() => void checkIncoming()}>
              {t('p2pTest.checkIncoming')}
            </button>
          </div>
          {localCandidate ? (
            <div className={styles.okRow}>
              {t('p2pTest.myCandidate', { addr: `${localCandidate.host}:${localCandidate.port}` })}
            </div>
          ) : null}
          {remoteCandidate ? (
            <div className={styles.okRow}>
              {t('p2pTest.friendCandidate', {
                addr: `${remoteCandidate.host}:${remoteCandidate.port}`,
              })}
            </div>
          ) : null}
        </div>

        <div className={styles.step}>
          <span className={styles.stepTitle}>{t('p2pTest.step6')}</span>
          <div className={styles.row}>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              disabled={!localCandidate || !remoteCandidate}
              onClick={() => void tryDirectConnect(true)}
            >
              <Wifi size={13} />
              {t('p2pTest.connectAsInitiator')}
            </button>
            <button
              type="button"
              className={controls.btn}
              disabled={!localCandidate || !remoteCandidate}
              onClick={() => void tryDirectConnect(false)}
            >
              {t('p2pTest.connectAsResponder')}
            </button>
          </div>
          <p className={styles.hint}>{t('p2pTest.initiatorHint')}</p>
          {connectedRemoteDeviceId ? (
            <div className={styles.okRow}>
              <Check size={13} /> {t('p2pTest.p2pSuccess', { device: connectedRemoteDeviceId })}
            </div>
          ) : null}
        </div>

        <div className={styles.logBox}>
          {log.length === 0 ? (
            <span className={styles.logEmpty}>{t('p2pTest.logEmpty')}</span>
          ) : (
            log.map((line, index) => <div key={index}>{line}</div>)
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
