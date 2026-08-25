import { useCallback, useEffect, useRef, useState } from 'react'

import {
  consumeRemoteCandidate,
  consumeRemoteInvitationCrossDevice,
  discoverP2pCandidate,
  exportPairingCode,
  p2pConnect,
  type PairingCode,
  parsePairingCode,
  prepareRemoteCandidate,
} from '../lib/api/p2pBridge'
import {
  connectRendezvous,
  drainRendezvousEvents,
  prepareRemoteInvitation,
  sendRendezvousFrame,
  verifyDiscoveredDevice,
} from '../lib/api/syncRendezvous'
import { syncIssueInvitation } from '../lib/api/syncSecurity'

const POLL_INTERVAL_MS = 3_000

export function useP2pFriendTest() {
  const [log, setLog] = useState<string[]>([])
  const [myCode, setMyCode] = useState<string | null>(null)
  const [friendCode, setFriendCode] = useState('')
  const [verifiedFriend, setVerifiedFriend] = useState<
    (PairingCode & { verifiedAgreementPublicKey: string }) | null
  >(null)
  const [rendezvousConnected, setRendezvousConnected] = useState(false)
  const [localCandidate, setLocalCandidate] = useState<{
    host: string
    port: number
    localPort: number
  } | null>(null)
  const [remoteCandidate, setRemoteCandidate] = useState<{ host: string; port: number } | null>(
    null,
  )
  const [connectedRemoteDeviceId, setConnectedRemoteDeviceId] = useState<string | null>(null)
  // Both people must agree on the same string for each of these — they're the authenticated data
  // bound into the encrypted envelope on send, and the delivered event carries no plaintext ID the
  // receiving side could otherwise use to know which value to decrypt with.
  const [sharedInvitationId, setSharedInvitationId] = useState('')
  const [sharedSessionId, setSharedSessionId] = useState('')
  const pollRef = useRef<number | undefined>(undefined)

  const push = useCallback((line: string) => {
    setLog((current) => [...current.slice(-199), `[${new Date().toLocaleTimeString()}] ${line}`])
  }, [])

  const loadMyCode = useCallback(async () => {
    try {
      const code = await exportPairingCode()
      setMyCode(code)
      push('Código de pareamento gerado — copie e envie pro seu amigo.')
    } catch (error) {
      push(`Falha ao gerar código: ${String(error)}`)
    }
  }, [push])

  const verifyFriend = useCallback(async () => {
    try {
      const parsed = await parsePairingCode(friendCode.trim())
      const verifiedKey = await verifyDiscoveredDevice({
        deviceId: parsed.deviceId,
        publicKey: parsed.publicKey,
        agreementPublicKey: parsed.agreementPublicKey,
        agreementBoundAtMs: parsed.agreementBoundAtMs,
        agreementBindingSignature: parsed.agreementBindingSignature,
      })
      setVerifiedFriend({ ...parsed, verifiedAgreementPublicKey: verifiedKey })
      push(`Dispositivo do amigo verificado: ${parsed.deviceId}.`)
    } catch (error) {
      push(`Código inválido ou assinatura não confere: ${String(error)}`)
    }
  }, [friendCode, push])

  const connect = useCallback(async () => {
    try {
      await connectRendezvous()
      setRendezvousConnected(true)
      push('Conectado ao Cloudflare rendezvous.')
    } catch (error) {
      push(`Falha ao conectar no rendezvous: ${String(error)}`)
    }
  }, [push])

  const sendInvite = useCallback(
    async (projectId: string) => {
      if (!verifiedFriend) {
        push('Verifique o código do amigo antes de enviar o convite.')
        return
      }
      try {
        const issued = await syncIssueInvitation({
          projectId,
          recipientAccountId: verifiedFriend.accountId,
          recipientDeviceId: verifiedFriend.deviceId,
          permissions: ['read'],
          pathScopes: [],
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        })
        setSharedInvitationId(issued.invitation.invitationId)
        push(
          `ID do convite (combine com o amigo, ele precisa colar isso antes de resgatar): ${issued.invitation.invitationId}`,
        )
        const envelope = await prepareRemoteInvitation({
          invitationId: issued.invitation.invitationId,
          bearerToken: issued.bearerToken,
          projectId: issued.invitation.projectId,
          permissions: issued.invitation.permissions,
          pathScopes: issued.invitation.pathScopes,
          expiresAtMs: issued.invitation.expiresAtMs,
          createdAtMs: issued.invitation.createdAtMs,
          recipientAccountRoute: verifiedFriend.accountRoute,
          recipientDeviceId: verifiedFriend.deviceId,
          recipientAgreementPublicKey: verifiedFriend.verifiedAgreementPublicKey,
        })
        await sendRendezvousFrame({
          type: 'enqueue',
          kind: 'invitation',
          messageId: envelope.messageId,
          recipientAccountRoute: envelope.recipientAccountRoute,
          recipientDeviceId: envelope.recipientDeviceId,
          expiresAtMs: envelope.expiresAtMs,
          ciphertext: envelope.ciphertext,
        })
        push('Convite criptografado enviado pelo relay do Cloudflare.')
      } catch (error) {
        push(`Falha ao enviar convite: ${String(error)}`)
      }
    },
    [verifiedFriend, push],
  )

  const checkIncoming = useCallback(async () => {
    try {
      const events = await drainRendezvousEvents()
      for (const event of events) {
        if (event.eventType !== 'delivery' || !event.ciphertext || !event.messageId) continue
        if (event.envelopeKind === 'invitation') {
          if (!sharedInvitationId.trim()) {
            push(
              'Convite chegou, mas falta colar o "ID do convite" combinado com o amigo antes de resgatar.',
            )
            continue
          }
          push('Cloudflare entregou um convite — resgatando...')
          try {
            await consumeRemoteInvitationCrossDevice(event.ciphertext, sharedInvitationId.trim())
            push('Convite resgatado — permissão concedida com sucesso.')
          } catch (error) {
            push(`Falha ao resgatar convite entregue: ${String(error)}`)
          }
        } else if (event.envelopeKind === 'candidate') {
          if (!sharedSessionId.trim()) {
            push(
              'Candidato chegou, mas falta combinar o "ID da sessão P2P" com o amigo antes de decifrar.',
            )
            continue
          }
          push('Cloudflare entregou um candidato de conexão direta.')
          try {
            const candidate = await consumeRemoteCandidate(event.ciphertext, sharedSessionId.trim())
            setRemoteCandidate({ host: candidate.publicHost, port: candidate.publicPort })
            push(`Candidato do amigo recebido: ${candidate.publicHost}:${candidate.publicPort}.`)
          } catch (error) {
            push(`Falha ao decifrar candidato: ${String(error)}`)
          }
        }
      }
    } catch (error) {
      push(`Falha ao verificar eventos do rendezvous: ${String(error)}`)
    }
  }, [push, sharedInvitationId, sharedSessionId])

  useEffect(() => {
    if (!rendezvousConnected) return
    pollRef.current = window.setInterval(() => void checkIncoming(), POLL_INTERVAL_MS)
    return () => window.clearInterval(pollRef.current)
  }, [rendezvousConnected, checkIncoming])

  const shareMyCandidate = useCallback(async () => {
    if (!verifiedFriend) {
      push('Verifique o código do amigo antes de compartilhar seu candidato.')
      return
    }
    if (!sharedSessionId.trim()) {
      push(
        'Combine um "ID da sessão P2P" com o amigo primeiro (qualquer texto, os dois digitam o mesmo).',
      )
      return
    }
    try {
      push('Descobrindo endereço público via STUN...')
      const discovered = await discoverP2pCandidate()
      setLocalCandidate({
        host: discovered.publicHost,
        port: discovered.publicPort,
        localPort: discovered.localPort,
      })
      push(`Endereço público descoberto: ${discovered.publicHost}:${discovered.publicPort}.`)
      const envelope = await prepareRemoteCandidate({
        sessionId: sharedSessionId.trim(),
        publicHost: discovered.publicHost,
        publicPort: discovered.publicPort,
        recipientAccountRoute: verifiedFriend.accountRoute,
        recipientDeviceId: verifiedFriend.deviceId,
        recipientAgreementPublicKey: verifiedFriend.verifiedAgreementPublicKey,
      })
      await sendRendezvousFrame({
        type: 'enqueue',
        kind: 'candidate',
        messageId: envelope.messageId,
        recipientAccountRoute: envelope.recipientAccountRoute,
        recipientDeviceId: envelope.recipientDeviceId,
        expiresAtMs: Date.now() + 5 * 60 * 1000,
        ciphertext: envelope.ciphertext,
      })
      push('Candidato enviado pro amigo pelo relay.')
    } catch (error) {
      push(`Falha ao compartilhar candidato: ${String(error)}`)
    }
  }, [verifiedFriend, sharedSessionId, push])

  const tryDirectConnect = useCallback(
    async (isInitiator: boolean) => {
      if (!localCandidate || !remoteCandidate) {
        push('Preciso do meu candidato e do candidato do amigo antes de tentar conectar.')
        return
      }
      try {
        push(`Tentando furar o NAT até ${remoteCandidate.host}:${remoteCandidate.port}...`)
        const result = await p2pConnect({
          localPort: localCandidate.localPort,
          peerHost: remoteCandidate.host,
          peerPort: remoteCandidate.port,
          isInitiator,
        })
        setConnectedRemoteDeviceId(result.remoteDeviceId)
        push(`P2P conectado! Dispositivo remoto autenticado: ${result.remoteDeviceId}.`)
      } catch (error) {
        push(`P2P falhou (provável NAT simétrico) — use o relay como alternativa: ${String(error)}`)
      }
    },
    [localCandidate, remoteCandidate, push],
  )

  return {
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
  }
}
