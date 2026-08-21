const INVITATION_LINK_SCHEME = 'alethe-invite'

export function buildInvitationLink(invitationId: string, bearerToken: string): string {
  return `${INVITATION_LINK_SCHEME}://${encodeURIComponent(invitationId)}#${encodeURIComponent(bearerToken)}`
}

export function parseInvitationLink(
  link: string,
): { invitationId: string; bearerToken: string } | null {
  const trimmed = link.trim()
  if (!trimmed.startsWith(`${INVITATION_LINK_SCHEME}://`)) return null
  const rest = trimmed.slice(`${INVITATION_LINK_SCHEME}://`.length)
  const [invitationPart, tokenPart] = rest.split('#')
  if (!invitationPart || !tokenPart) return null
  try {
    const invitationId = decodeURIComponent(invitationPart)
    const bearerToken = decodeURIComponent(tokenPart)
    if (!invitationId || !bearerToken) return null
    return { invitationId, bearerToken }
  } catch {
    return null
  }
}
