import type { MessageKey } from './i18n'

export type ChangelogRelease = {
  version: string
  date: string
  noteKeys: MessageKey[]
}

export const CHANGELOG_RELEASES: ChangelogRelease[] = [
  {
    version: '1.5.0',
    date: '2026-08-09',
    noteKeys: [
      'whatsNew.v150.note1',
      'whatsNew.v150.note2',
      'whatsNew.v150.note3',
      'whatsNew.v150.note4',
      'whatsNew.v150.note5',
      'whatsNew.v150.note6',
    ],
  },
  {
    version: '1.4.1',
    date: '2026-08-07',
    noteKeys: ['whatsNew.v141.note1'],
  },
  {
    version: '1.4.0',
    date: '2026-08-07',
    noteKeys: [
      'whatsNew.v140.note1',
      'whatsNew.v140.note2',
      'whatsNew.v140.note3',
      'whatsNew.v140.note4',
      'whatsNew.v140.note5',
      'whatsNew.v140.note6',
      'whatsNew.v140.note7',
      'whatsNew.v140.note8',
      'whatsNew.v140.note9',
      'whatsNew.v140.note10',
      'whatsNew.v140.note11',
      'whatsNew.v140.note12',
      'whatsNew.v140.note13',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-07-27',
    noteKeys: [
      'whatsNew.v130.note1',
      'whatsNew.v130.note2',
      'whatsNew.v130.note3',
      'whatsNew.v130.note4',
      'whatsNew.v130.note5',
      'whatsNew.v130.note6',
      'whatsNew.v130.note7',
      'whatsNew.v130.note8',
    ],
  },
]

export const CURRENT_VERSION = CHANGELOG_RELEASES[0].version
