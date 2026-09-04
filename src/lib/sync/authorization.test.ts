import { describe, expect, it } from 'vitest'

import {
  authorizeProjectOperation,
  type EnforcedProjectGrant,
  issueInvitation,
  normalizeRelativeSyncPath,
  PERMISSION_PRESETS,
  redeemInvitation,
  revokeInvitation,
} from './authorization'

const ids = {
  project: 'project-a' as never,
  otherProject: 'project-b' as never,
  account: 'account-a' as never,
  otherAccount: 'account-b' as never,
  device: 'device-a' as never,
  otherDevice: 'device-b' as never,
  invitation: 'invitation-a' as never,
  grant: 'grant-a' as never,
}

const grant: EnforcedProjectGrant = {
  id: ids.grant,
  projectId: ids.project,
  subject: { accountId: ids.account, deviceId: ids.device },
  permissions: PERMISSION_PRESETS.collaborate,
  pathScopes: [
    { effect: 'allow', pattern: 'src/**' },
    { effect: 'deny', pattern: 'src/secrets/**' },
  ],
  issuedAt: 1_000,
}

describe('project authorization', () => {
  it('denies cross-project, cross-account, and cross-device escalation', () => {
    expect(
      authorizeProjectOperation(grant, {
        projectId: ids.otherProject,
        accountId: ids.account,
        deviceId: ids.device,
        operation: 'read',
      }),
    ).toEqual({ allowed: false, reason: 'wrong_project' })
    expect(
      authorizeProjectOperation(grant, {
        projectId: ids.project,
        accountId: ids.otherAccount,
        deviceId: ids.device,
        operation: 'read',
      }),
    ).toEqual({ allowed: false, reason: 'wrong_subject' })
    expect(
      authorizeProjectOperation(grant, {
        projectId: ids.project,
        accountId: ids.account,
        deviceId: ids.otherDevice,
        operation: 'read',
      }),
    ).toEqual({ allowed: false, reason: 'device_not_granted' })
  })

  it('enforces explicit permissions and deny-first path scopes', () => {
    expect(
      authorizeProjectOperation(grant, {
        projectId: ids.project,
        accountId: ids.account,
        deviceId: ids.device,
        operation: 'write',
        relativePath: 'src/index.ts',
      }),
    ).toEqual({ allowed: true, permission: 'write' })
    expect(
      authorizeProjectOperation(grant, {
        projectId: ids.project,
        accountId: ids.account,
        deviceId: ids.device,
        operation: 'delete',
        relativePath: 'src/index.ts',
      }),
    ).toEqual({ allowed: false, reason: 'permission_denied' })
    expect(
      authorizeProjectOperation(grant, {
        projectId: ids.project,
        accountId: ids.account,
        deviceId: ids.device,
        operation: 'read',
        relativePath: 'src/secrets/token.txt',
      }),
    ).toEqual({ allowed: false, reason: 'path_denied' })
  })

  it('rejects absolute paths and traversal before scope evaluation', () => {
    expect(normalizeRelativeSyncPath('../secret')).toBeNull()
    expect(normalizeRelativeSyncPath('src/../../secret')).toBeNull()
    expect(normalizeRelativeSyncPath('/etc/passwd')).toBeNull()
    expect(normalizeRelativeSyncPath('C:\\Users\\secret')).toBeNull()
  })

  it('fails closed when a persisted scope is malformed', () => {
    expect(
      authorizeProjectOperation(
        { ...grant, pathScopes: [{ effect: 'deny', pattern: '../secrets/**' }] },
        {
          projectId: ids.project,
          accountId: ids.account,
          deviceId: ids.device,
          operation: 'read',
          relativePath: 'src/index.ts',
        },
      ),
    ).toEqual({ allowed: false, reason: 'path_denied' })
  })
})

describe('single-use invitations', () => {
  it('redeems once for the exact audience without persisting the raw token', async () => {
    const issued = await issueInvitation({
      id: ids.invitation,
      projectId: ids.project,
      issuerDeviceId: ids.device,
      audience: { accountId: ids.account, deviceId: ids.otherDevice },
      permissions: ['write'],
      now: 1_000,
      expiresAt: 10_000,
    })
    expect(JSON.stringify(issued.invitation)).not.toContain(issued.token)

    const redeemed = await redeemInvitation(
      issued.invitation,
      issued.token,
      { accountId: ids.account, deviceId: ids.otherDevice },
      2_000,
    )
    expect(redeemed?.grant.permissions).toEqual(['write', 'read'])
    expect(
      await redeemInvitation(
        redeemed!.invitation,
        issued.token,
        { accountId: ids.account, deviceId: ids.otherDevice },
        2_001,
      ),
    ).toBeNull()
  })

  it('rejects wrong recipients, expired tokens, invalid tokens, and post-redemption revoke', async () => {
    const issued = await issueInvitation({
      id: ids.invitation,
      projectId: ids.project,
      issuerDeviceId: ids.device,
      audience: { accountId: ids.account },
      permissions: ['read'],
      now: 1_000,
      expiresAt: 2_000,
    })
    expect(
      await redeemInvitation(
        issued.invitation,
        issued.token,
        { accountId: ids.otherAccount, deviceId: ids.otherDevice },
        1_500,
      ),
    ).toBeNull()
    expect(
      await redeemInvitation(
        issued.invitation,
        'wrong-token',
        { accountId: ids.account, deviceId: ids.otherDevice },
        1_500,
      ),
    ).toBeNull()
    expect(
      await redeemInvitation(
        issued.invitation,
        issued.token,
        { accountId: ids.account, deviceId: ids.otherDevice },
        2_001,
      ),
    ).toBeNull()

    const redeemed = await redeemInvitation(
      issued.invitation,
      issued.token,
      { accountId: ids.account, deviceId: ids.otherDevice },
      1_500,
    )
    expect(() => revokeInvitation(redeemed!.invitation, 1_600)).toThrow(
      'invitation_already_redeemed',
    )
  })
})
