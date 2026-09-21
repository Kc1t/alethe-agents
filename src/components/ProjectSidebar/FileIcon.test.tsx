import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FileIcon } from './FileIcon'

describe('FileIcon', () => {
  it('renders without crashing for diverse file types', () => {
    const files = [
      'index.ts',
      'App.tsx',
      'script.py',
      'main.rs',
      'data.json',
      'README.md',
      '.gitignore',
      '.env.local',
      'Dockerfile',
      'logo.svg',
      'video.mp4',
      'music.mp3',
      'archive.zip',
      'document.pdf',
      'unknown.custom',
    ]

    for (const fileName of files) {
      const { container } = render(<FileIcon fileName={fileName} size={14} />)
      expect(container.querySelector('svg')).not.toBeNull()
    }
  })
})
