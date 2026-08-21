import { describe, expect, it } from 'vitest'

import { buildInvitationLink, parseInvitationLink } from './invitationLink'

describe('invitationLink', () => {
  it('round-trips an invitation id and bearer token through a link', () => {
    const link = buildInvitationLink('inv_abc123', 'token-with-special/chars+==')
    const parsed = parseInvitationLink(link)
    expect(parsed).toEqual({
      invitationId: 'inv_abc123',
      bearerToken: 'token-with-special/chars+==',
    })
  })

  it('rejects links with the wrong scheme', () => {
    expect(parseInvitationLink('https://example.test/inv_abc123#token')).toBeNull()
  })

  it('rejects links missing the invitation id or the token', () => {
    expect(parseInvitationLink('alethe-invite://#token')).toBeNull()
    expect(parseInvitationLink('alethe-invite://inv_abc123#')).toBeNull()
  })

  it('rejects unparsable garbage without throwing', () => {
    expect(parseInvitationLink('not a link at all')).toBeNull()
  })
})
