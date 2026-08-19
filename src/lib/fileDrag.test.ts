import { describe, expect, it } from 'vitest'

import { ALETHE_FILE_DRAG_TYPE, readFileDragPayload } from './fileDrag'

function transfer(raw: string): DataTransfer {
  return {
    getData: (type: string) => (type === ALETHE_FILE_DRAG_TYPE ? raw : ''),
  } as DataTransfer
}

describe('file drag payloads', () => {
  it('reads a valid workspace file payload', () => {
    expect(readFileDragPayload(transfer('{"projectId":"p1","path":"C:\\\\repo\\\\a.ts"}'))).toEqual({
      projectId: 'p1',
      path: 'C:\\repo\\a.ts',
    })
  })

  it('rejects malformed and incomplete payloads', () => {
    expect(readFileDragPayload(transfer('not json'))).toBeNull()
    expect(readFileDragPayload(transfer('{"projectId":"p1"}'))).toBeNull()
  })
})
